// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../../base/interface/IUniversalLiquidator.sol";
import "../../base/upgradability/BaseUpgradeableStrategy.sol";
import "../../base/interface/aerodromeV2/IAeroV2Gauge.sol";
import "../../base/interface/aerodromeV2/IAeroV2GaugeFactory.sol";
import "../../base/interface/aerodromeV2/IAeroV2Pool.sol";
import "../../base/interface/aerodromeV2/IAeroV2PoolFactory.sol";
import "../../base/interface/aerodromeV2/IVaultInvestFlags.sol";

/**
 * @title AerodromeV2Strategy
 * @dev Stakes the LP of a new Aero (ex-Aerodrome) Basic Volatile or Basic Stable pool in its gauge and compounds
 * the AERO emissions back into the LP. The logic is the same for both pool types; AerodromeV2VolatileStrategy and
 * AerodromeV2StableStrategy only pin the pool type, which initialization checks against the pool.
 */
abstract contract AerodromeV2Strategy is BaseUpgradeableStrategy {
  using SafeERC20 for IERC20;

  address public constant harvestMSIG = address(0x97b3e5712CDE7Db13e939a188C8CA90Db5B05131);

  /// @dev Reward balances below this are dust: not worth liquidating, and RewardForwarder.notifyFee reverts on 0 fees
  uint256 internal constant MIN_REWARD = 1e13;
  /// @dev Fraction of a reserve used to probe the pool's marginal price
  uint256 internal constant PRICE_PROBE_DIVISOR = 10_000;
  uint256 internal constant DEFAULT_STAKE_SPACING = 10;
  uint256 internal constant MAX_STAKE_SPACING = 1_000;
  /// @dev About a day of Base blocks (0.2 s each since November 2026): even with no window the strategy stakes at most
  /// this often, so a window that Aero switches on later (it also covers existing stakes) is unlikely to find a recent
  /// stake. Blocks, like Aero's windows, so the odds stay the same if the block time changes again.
  uint256 internal constant DEFAULT_MIN_STAKE_INTERVAL = 432_000;
  /// @dev About 30 days of Base blocks
  uint256 internal constant MAX_MIN_STAKE_INTERVAL = 12_960_000;
  /// @dev Gas a gauge withdraw needs on top of what Aero reserves for its gauge tape (gaugeTapeGasLimit)
  uint256 internal constant GAUGE_EXIT_GAS = 1_000_000;
  /// @dev Gas kept back from a best-effort gauge withdraw, so the emergencyWithdraw fallback can still run when the
  /// withdraw burns all the gas it was given
  uint256 internal constant GAUGE_FALLBACK_GAS = 200_000;

  // additional storage slots (on top of BaseUpgradeableStrategy ones) are defined here
  bytes32 internal constant _STAKE_SPACING_SLOT = 0xdb0c127b40d22d3cc92da10472a99818c8393b96aea0d59174d5e551aad38274;
  bytes32 internal constant _MIN_STAKE_INTERVAL_SLOT = 0x6a65b92997f3c14d085295437048ef3e20a5e80bba1236eeed73772906057b3c;
  bytes32 internal constant _LAST_STAKE_BLOCK_SLOT = 0x8b4eba188c0b0c912b87240da63577b062e97cdcb05acaea868c9b6a05b7c18a;
  bytes32 internal constant _KEEP_UNSTAKED_SLOT = 0x84b26c5b630ab978ee4cc29ce60a1261d4c810a9cde25388086693b0035663dc;
  bytes32 internal constant _FEE_PAID_REWARD_SLOT = 0xdee4b1c857a7cb713eed053196a5167e138327b62a7962ed114649742e13d192;

  event GaugeChanged(address oldGauge, address newGauge);
  event ClaimSkipped(uint256 windowEndBlock);
  event ClaimFailed(bytes reason);
  event StakeSkipped(uint256 idleAmount);
  event StakeFailed(bytes reason);
  event LiquidationFailed(bytes reason);
  event CompoundFailed(bytes reason);
  event GaugeExitFailed(bytes reason);
  event StakeSpacingChanged(uint256 stakeSpacing);
  event MinStakeIntervalChanged(uint256 minStakeInterval);
  event KeepUnstakedChanged(bool keepUnstaked);
  event UnstakedFromGauge(uint256 amount);
  event RewardTokenRemoved(address token);

  constructor() BaseUpgradeableStrategy() {
    assert(_STAKE_SPACING_SLOT == bytes32(uint256(keccak256("eip1967.strategyStorage.stakeSpacing")) - 1));
    assert(_MIN_STAKE_INTERVAL_SLOT == bytes32(uint256(keccak256("eip1967.strategyStorage.minStakeInterval")) - 1));
    assert(_LAST_STAKE_BLOCK_SLOT == bytes32(uint256(keccak256("eip1967.strategyStorage.lastStakeBlock")) - 1));
    assert(_KEEP_UNSTAKED_SLOT == bytes32(uint256(keccak256("eip1967.strategyStorage.keepUnstaked")) - 1));
    assert(_FEE_PAID_REWARD_SLOT == bytes32(uint256(keccak256("eip1967.strategyStorage.feePaidReward")) - 1));
  }

  /**
   * @notice Initializes the strategy and checks that the pool has this strategy's type and the gauge stakes its LP.
   * @param _storage Address of the storage contract.
   * @param _underlying Address of the Aero pool (LP token).
   * @param _vault Address of the vault.
   * @param _gauge Address of the pool's Aero V2 gauge.
   * @param _rewardToken Address of the reward token (AERO).
   */
  function initializeBaseStrategy(
    address _storage,
    address _underlying,
    address _vault,
    address _gauge,
    address _rewardToken
  ) public initializer {
    BaseUpgradeableStrategy.initialize(_storage, _underlying, _vault, _gauge, _rewardToken, harvestMSIG);
    require(IAeroV2Pool(_underlying).POOL_TYPE() == _poolType(), "Pool type mismatch");
    require(IAeroV2Gauge(_gauge).stakingToken() == _underlying, "Underlying mismatch");
    setUint256(_STAKE_SPACING_SLOT, DEFAULT_STAKE_SPACING);
    setUint256(_MIN_STAKE_INTERVAL_SLOT, DEFAULT_MIN_STAKE_INTERVAL);
  }

  /**
   * @notice Claims AERO, compounds it into LP and stakes idle LP, without ever losing rewards to the penalty window.
   * @dev Inside a penalty window it skips the claim and the stake (no revert); rewards stay in the gauge until a
   * later run. Fee claims, the liquidation, the compounding after it and the gauge deposit are isolated so none of them
   * can block the others, except for Aero's own gas check (_revertOnGasFailure): that reverts the hard work, so a
   * keeper that sent too little gas retries with more instead of silently skipping a step.
   * The vault must keep investOnDeposit and compoundOnWithdraw off (new vaults start with investOnDeposit on). While
   * either is on, every hard work the vault runs reverts: user deposits (investOnDeposit), every user withdrawal
   * (compoundOnWithdraw) and the keeper's hard work. Governance can still call this directly.
   */
  function doHardWork() external restricted {
    // User deposits/withdrawals must never reach the gauge: each deposit would restart the penalty window. A vault that
    // runs hard work for users fails loudly: the keeper's hard work comes through the vault too, so skipping would
    // silently stop all compounding
    require(msg.sender != vault() || !_vaultRunsHardWorkForUsers(), "investOnDeposit or compoundOnWithdraw is on");
    require(!pausedInvesting(), "Action blocked as the strategy is in emergency state");

    try IAeroV2Pool(underlying()).claimFees(address(this)) {} catch {}
    bool claimed = _claimRewards();
    try this.liquidateRewards() {} catch (bytes memory reason) {
      _revertOnGasFailure(reason);
      emit LiquidationFailed(reason);
    }
    _stakeIdle(claimed);
  }

  /**
   * @notice Sells reward tokens and adds the proceeds to the pool. Only callable by this contract.
   * @dev External so doHardWork and withdrawAllToVault can isolate failures (e.g. a missing liquidation route).
   */
  function liquidateRewards() external {
    require(msg.sender == address(this), "Only self");
    _liquidateRewards();
  }

  /**
   * @dev Claims emissions only outside the penalty window.
   * @return claimed True when everything unclaimed was paid out, so a deposit can follow safely.
   */
  function _claimRewards() internal returns (bool claimed) {
    IAeroV2Gauge gauge = IAeroV2Gauge(rewardPool());
    if (gauge.isPenaltyActive(address(this))) {
      emit ClaimSkipped(gauge.depositBlock(address(this)) + _penaltyConfig(address(gauge)).minStakeBlocks);
      return false;
    }
    try gauge.claimEmissions(address(this), address(this)) {
      return true;
    } catch (bytes memory reason) {
      _revertOnGasFailure(reason);
      emit ClaimFailed(reason);
      return false;
    }
  }

  /**
   * @dev Stakes idle LP when that cannot cost rewards: after a successful claim while Aero enforces a window, and not
   * before _nextStakeBlock. A switched-off gauge pays no AERO and its stakers get no pool fees, so it gets no new LP
   * and its stake is taken out, right after a successful claim (nothing left to forfeit), to earn pool fees instead.
   * Governance's keepUnstaked switch does the same for a gauge that Aero has not switched off.
   */
  function _stakeIdle(bool claimed) internal {
    address underlying_ = underlying();
    address gauge = rewardPool();
    IAeroV2GaugeFactory factory = IAeroV2GaugeFactory(IAeroV2Gauge(gauge).gaugeFactory());
    if (keepUnstaked() || factory.emissionCap(gauge) == 0) {
      uint256 staked = _rewardPoolBalance();
      if (staked > 0 && claimed && _withdrawFromGauge(staked, true)) {
        emit UnstakedFromGauge(staked);
      }
      uint256 unstaked = IERC20(underlying_).balanceOf(address(this));
      if (unstaked > 0) {
        emit StakeSkipped(unstaked);
      }
      return;
    }
    uint256 idle = IERC20(underlying_).balanceOf(address(this));
    if (idle == 0) {
      return;
    }
    IAeroV2GaugeFactory.PenaltyConfig memory config = factory.effectivePenaltyConfig(gauge);
    bool windowEnforced = config.minStakeBlocks > 0 && config.penaltyRate > 0;
    if ((windowEnforced && !claimed) || block.number < _nextStakeBlock(gauge, config)) {
      emit StakeSkipped(idle);
      return;
    }
    IERC20(underlying_).safeApprove(gauge, 0);
    IERC20(underlying_).safeApprove(gauge, idle);
    try IAeroV2Gauge(gauge).deposit(idle) {
      setUint256(_LAST_STAKE_BLOCK_SLOT, block.number);
    } catch (bytes memory reason) {
      _revertOnGasFailure(reason);
      IERC20(underlying_).safeApprove(gauge, 0);
      emit StakeFailed(reason);
    }
  }

  /**
   * @dev Sells any extra reward tokens for the main reward token, takes the protocol fees on it and swaps the rest into
   * the pool's tokens, then turns the pool tokens the strategy holds into LP: the swap proceeds, the pool fees claimed
   * for idle LP and earlier leftovers, with or without a reward sale (even with selling switched off), all but the
   * reward tokens whose fees a later sale takes (`reserved`). What a failed compounding left of the reward token after
   * its fees (feePaidReward) is compounded like the other pool tokens, without its fees being taken again.
   */
  function _liquidateRewards() internal {
    address _rewardToken = rewardToken();
    uint256 rewardHeld = IERC20(_rewardToken).balanceOf(address(this));
    uint256 feePaid = Math.min(feePaidReward(), rewardHeld);
    if (!sell()) {
      emit ProfitsNotCollected(sell(), false);
      _tryCompoundPoolTokens(_rewardToken, rewardHeld - feePaid);
      return;
    }

    address _universalLiquidator = universalLiquidator();
    address[] memory _rewardTokens = rewardTokens();
    for (uint256 i = 0; i < _rewardTokens.length; i++) {
      address token = _rewardTokens[i];
      if (token == _rewardToken) {
        continue;
      }
      uint256 balance = IERC20(token).balanceOf(address(this));
      if (balance == 0) {
        continue;
      }
      IERC20(token).safeApprove(_universalLiquidator, 0);
      IERC20(token).safeApprove(_universalLiquidator, balance);
      try IUniversalLiquidator(_universalLiquidator).swap(token, _rewardToken, balance, 1, address(this)) {} catch (bytes memory reason) {
        _revertOnGasFailure(reason);
        IERC20(token).safeApprove(_universalLiquidator, 0);
        emit LiquidationFailed(reason);
      }
    }

    // Reward dust waits for a later claim: it is neither sold nor added to the pool before its fees are taken
    bool rewardSold = false;
    uint256 rewardBalance = IERC20(_rewardToken).balanceOf(address(this)) - feePaid;
    if (rewardBalance >= MIN_REWARD) {
      _notifyProfitInRewardToken(_rewardToken, rewardBalance);
      // Split only what the fees left of rewardBalance: feePaid is the reward-token share that earlier splits kept
      uint256 remainingRewardBalance = IERC20(_rewardToken).balanceOf(address(this)) - feePaid;
      if (remainingRewardBalance >= MIN_REWARD) {
        _swapRewardIntoPoolTokens(_rewardToken, remainingRewardBalance, _universalLiquidator);
        rewardSold = true;
      }
    }
    _tryCompoundPoolTokens(_rewardToken, rewardSold ? 0 : IERC20(_rewardToken).balanceOf(address(this)) - feePaid);
  }

  /**
   * @notice Turns the pool tokens the strategy holds into LP. Only callable by this contract.
   * @dev External so _liquidateRewards can isolate a failure: the pool tokens then wait for the next run instead of
   * undoing the reward sale and the fees taken before it (feePaidReward keeps those fees from being taken again).
   */
  function compoundPoolTokens(address _rewardToken, uint256 reserved) external {
    require(msg.sender == address(this), "Only self");
    _compoundPoolTokens(_rewardToken, reserved);
  }

  function _tryCompoundPoolTokens(address _rewardToken, uint256 reserved) internal {
    uint256 feePaid = 0;
    try this.compoundPoolTokens(_rewardToken, reserved) {} catch (bytes memory reason) {
      _revertOnGasFailure(reason);
      emit CompoundFailed(reason);
      feePaid = IERC20(_rewardToken).balanceOf(address(this)) - reserved;
    }
    setUint256(_FEE_PAID_REWARD_SLOT, feePaid);
  }

  /// @dev Splits `_amount` of the reward token by the pool's value shares and swaps it into the pool's tokens
  function _swapRewardIntoPoolTokens(address _rewardToken, uint256 _amount, address _universalLiquidator) internal {
    IAeroV2Pool pool = IAeroV2Pool(underlying());
    address token0 = pool.token0();
    address token1 = pool.token1();

    (uint256 reserve0, uint256 reserve1,) = pool.getReserves();
    if (reserve0 == 0 || reserve1 == 0) {
      return;
    }
    uint256 value0 = _reserveValue(pool, token0, reserve0, reserve1);
    uint256 toToken0 = _amount * value0 / (value0 + reserve1);
    uint256 toToken1 = _amount - toToken0;

    uint256 toSwap = (token0 == _rewardToken ? 0 : toToken0) + (token1 == _rewardToken ? 0 : toToken1);
    IERC20(_rewardToken).safeApprove(_universalLiquidator, 0);
    IERC20(_rewardToken).safeApprove(_universalLiquidator, toSwap);
    if (token0 != _rewardToken && toToken0 > 0) {
      IUniversalLiquidator(_universalLiquidator).swap(_rewardToken, token0, toToken0, 1, address(this));
    }
    if (token1 != _rewardToken && toToken1 > 0) {
      IUniversalLiquidator(_universalLiquidator).swap(_rewardToken, token1, toToken1, 1, address(this));
    }
  }

  /**
   * @dev Turns the pool tokens the strategy holds into LP. First the side in excess of the pool's ratio has the part of
   * its surplus that belongs to the other side (the other side's value share) swapped through the pool itself.
   * @param reserved Reward-token balance to leave out, whose fees a later sale takes: reward dust (a second time
   * for what the fees left of a reward just above MIN_REWARD), or everything but feePaidReward while selling is
   * switched off
   */
  function _compoundPoolTokens(address _rewardToken, uint256 reserved) internal {
    IAeroV2Pool pool = IAeroV2Pool(underlying());
    address token0 = pool.token0();
    address token1 = pool.token1();
    uint256 amount0 = _poolTokenBalance(token0, _rewardToken, reserved);
    uint256 amount1 = _poolTokenBalance(token1, _rewardToken, reserved);
    if (amount0 == 0 && amount1 == 0) {
      return;
    }
    (uint256 reserve0, uint256 reserve1,) = pool.getReserves();
    if (reserve0 == 0 || reserve1 == 0) {
      return;
    }
    uint256 amount1Optimal = amount0 * reserve1 / reserve0;
    if (amount1 > amount1Optimal) {
      uint256 value1 = _reserveValue(pool, token1, reserve1, reserve0);
      _swapInPool(pool, token0, token1, (amount1 - amount1Optimal) * reserve0 / (reserve0 + value1));
    } else {
      uint256 value0 = _reserveValue(pool, token0, reserve0, reserve1);
      _swapInPool(pool, token0, token0, (amount0 - amount1 * reserve0 / reserve1) * reserve1 / (reserve1 + value0));
    }

    (reserve0, reserve1,) = pool.getReserves();
    amount0 = _poolTokenBalance(token0, _rewardToken, reserved);
    amount1 = _poolTokenBalance(token1, _rewardToken, reserved);
    amount1Optimal = amount0 * reserve1 / reserve0;
    if (amount1Optimal <= amount1) {
      amount1 = amount1Optimal;
    } else {
      amount0 = amount1 * reserve0 / reserve1;
    }
    uint256 supply = pool.totalSupply();
    if (amount0 * supply / reserve0 == 0 || amount1 * supply / reserve1 == 0) {
      return; // pool.mint would revert with InsufficientLiquidityMinted
    }
    IERC20(token0).safeTransfer(address(pool), amount0);
    IERC20(token1).safeTransfer(address(pool), amount1);
    pool.mint(address(this));
  }

  function _poolTokenBalance(address token, address _rewardToken, uint256 reserved) internal view returns (uint256) {
    uint256 balance = IERC20(token).balanceOf(address(this));
    return token == _rewardToken ? balance - reserved : balance;
  }

  /// @dev `reserveIn` of `tokenIn` valued in the other pool token at the pool's own marginal price, net of the swap fee
  /// (`reserveOut`, an even split, for dust reserves). A probe moves the price it measures (by about
  /// 1/PRICE_PROBE_DIVISOR on a volatile pool), so the pool is probed with one and with two probe sizes and the price is
  /// extrapolated to a trade of zero size, which cancels that effect to first order.
  function _reserveValue(IAeroV2Pool pool, address tokenIn, uint256 reserveIn, uint256 reserveOut)
    internal
    view
    returns (uint256 value)
  {
    value = reserveOut;
    uint256 probe = reserveIn / PRICE_PROBE_DIVISOR;
    if (probe > 0) {
      uint256 probeOut = pool.getAmountOut(probe, tokenIn);
      uint256 doubleProbeOut = pool.getAmountOut(2 * probe, tokenIn);
      // a pool's quote is concave, so doubleProbeOut <= 2 * probeOut + 1 (rounding) < 4 * probeOut once probeOut > 0:
      // the second check only keeps a broken quote from underflowing (the fallback applies instead)
      if (probeOut > 0 && doubleProbeOut < 4 * probeOut) {
        value = (4 * probeOut - doubleProbeOut) * reserveIn / (2 * probe);
      }
    }
  }

  /// @dev Swaps `amountIn` of `tokenIn` for the other pool token through the pool itself, quoted with the pool's full
  /// fee for this transaction so that the swap always passes the pool's own check. Skipped while Aero has paused swaps,
  /// so that what is already in the pool's ratio is still minted (minting still works).
  function _swapInPool(IAeroV2Pool pool, address token0, address tokenIn, uint256 amountIn) internal {
    if (amountIn == 0 || IAeroV2PoolFactory(pool.factory()).isPaused()) {
      return;
    }
    uint256 amountOut = pool.getAmountOutWithTotalFee(amountIn, tokenIn);
    if (amountOut == 0) {
      return;
    }
    IERC20(tokenIn).safeTransfer(address(pool), amountIn);
    if (tokenIn == token0) {
      pool.swap(0, amountOut, address(this), "");
    } else {
      pool.swap(amountOut, 0, address(this), "");
    }
  }

  function withdrawToVault(uint256 _amount) public restricted {
    address underlying_ = underlying();
    uint256 idle = IERC20(underlying_).balanceOf(address(this));
    if (_amount > idle) {
      _withdrawFromGauge(Math.min(_rewardPoolBalance(), _amount - idle), false);
    }
    IERC20(underlying_).safeTransfer(vault(), _amount);
  }

  /**
   * @notice Unstakes everything and sends all underlying to the vault. Used by vault.withdrawAll, rebalance,
   * setStrategy (migration) and the last-share withdrawal, so nothing after the unstake can block it. If the gauge's
   * withdraw fails, governance's emergencyExit can take the stake out first; a gauge whose views revert blocks both
   * (see setKeepUnstaked).
   */
  function withdrawAllToVault() public restricted {
    address gauge = rewardPool();
    _withdrawFromGauge(_rewardPoolBalance(), false);
    // Nothing is staked any more, so there is no penalty window: this only collects emissions deferred by a failed mint
    try IAeroV2Gauge(gauge).claimEmissions(address(this), address(this)) {} catch {}
    try IAeroV2Pool(underlying()).claimFees(address(this)) {} catch {}
    try this.liquidateRewards() {} catch (bytes memory reason) {
      emit LiquidationFailed(reason);
    }
    address underlying_ = underlying();
    IERC20(underlying_).safeTransfer(vault(), IERC20(underlying_).balanceOf(address(this)));
  }

  /**
   * @notice Pauses investing and unstakes everything. Of the exit functions, the only one that falls back to Aero's
   * emergencyWithdraw (forfeiting unclaimed AERO) when the gauge's withdraw fails and Aero has enabled it; a failed
   * exit (GaugeExitFailed) does not undo the pause. The hard work's own exit right after a claim, from a gauge Aero
   * switched off or while keepUnstaked is on, falls back too, with nothing left to forfeit.
   */
  function emergencyExit() public onlyGovernance {
    _setPausedInvesting(true);
    _withdrawFromGauge(_rewardPoolBalance(), true);
    emit ToggledEmergencyState(true);
  }

  /**
   * @notice Resumes investing after an emergency exit.
   */
  function continueInvesting() public onlyGovernance {
    _setPausedInvesting(false);
    emit ToggledEmergencyState(false);
  }

  /**
   * @dev Unstakes `amount` from the gauge. No penalty-window check on purpose (exits must always work).
   * @param bestEffort False for user withdrawals, withdrawAll and gauge migration: any gauge failure reverts, so none
   * of them can leave a stake behind or be steered into emergencyWithdraw by its gas limit. True for governance's
   * emergencyExit and for the hard work leaving the gauge right after a claim, when Aero has switched it off or
   * governance keeps the LP unstaked (keepUnstaked): see _tryExitGauge.
   * @return exited False when a best-effort exit failed (GaugeExitFailed was emitted)
   */
  function _withdrawFromGauge(uint256 amount, bool bestEffort) internal returns (bool exited) {
    if (amount == 0) {
      return true;
    }
    IAeroV2Gauge gauge = IAeroV2Gauge(rewardPool());
    if (bestEffort) {
      exited = _tryExitGauge(gauge, amount);
    } else {
      gauge.withdraw(amount);
      exited = true;
    }
    if (exited && gauge.balanceOf(address(this)) == 0) {
      setUint256(_LAST_STAKE_BLOCK_SLOT, 0); // nothing staked any more, so the next stake need not wait
    }
  }

  /**
   * @dev Withdraws `amount`, falling back to emergencyWithdraw (which forfeits unclaimed AERO) when the gauge fails and
   * Aero has enabled it. The caller must send enough gas for the whole gauge call, several times what a withdraw
   * normally needs, and part of it is kept back for the fallback: too little gas reverts before the gauge is called,
   * and a withdraw that burns all its gas still leaves enough for the fallback. Aero's own gas check is re-raised.
   * @return False, after emitting GaugeExitFailed, when both fail
   */
  function _tryExitGauge(IAeroV2Gauge gauge, uint256 amount) internal returns (bool) {
    IAeroV2GaugeFactory factory = IAeroV2GaugeFactory(gauge.gaugeFactory());
    require(
      gasleft() >= uint256(factory.gaugeTapeGasLimit()) + GAUGE_EXIT_GAS + GAUGE_FALLBACK_GAS,
      "Not enough gas for the gauge"
    );
    try gauge.withdraw{gas: gasleft() - GAUGE_FALLBACK_GAS}(amount) {
      return true;
    } catch (bytes memory reason) {
      _revertOnGasFailure(reason);
      if (factory.emergencyWithdrawEnabled()) {
        try gauge.emergencyWithdraw(amount) {
          return true;
        } catch (bytes memory emergencyReason) {
          reason = emergencyReason;
        }
      }
      emit GaugeExitFailed(reason);
      return false;
    }
  }

  /// @dev Re-raises a failure from Aero's own gas check (a gauge or pool tape needing more gas than was left): more gas
  /// fixes it, so it never justifies skipping a step or leaving through emergencyWithdraw
  function _revertOnGasFailure(bytes memory reason) internal pure {
    if (keccak256(reason) == keccak256(abi.encodeWithSelector(IAeroV2GaugeFactory.InsufficientGasForCall.selector))) {
      _revertWith(reason);
    }
  }

  function _revertWith(bytes memory reason) internal pure {
    assembly {
      revert(add(reason, 32), mload(reason))
    }
  }

  /**
   * @notice Returns the total underlying managed by the strategy (staked + idle).
   */
  function investedUnderlyingBalance() external view returns (uint256) {
    return _rewardPoolBalance() + IERC20(underlying()).balanceOf(address(this));
  }

  /**
   * @notice Penalty window of this strategy's gauge position, for keepers and monitoring.
   * @return minStakeBlocks Window length set by Aero for this gauge (0 = no window).
   * @return penaltyRate Share of unclaimed emissions forfeited inside the window, in PIPS (1e6 = 100%).
   * @return windowEndBlock First block where claiming is free again (0 when nothing is staked).
   * @return inWindow True while a claim or gauge withdraw by this strategy would forfeit rewards.
   */
  function penaltyWindow()
    external
    view
    returns (uint256 minStakeBlocks, uint256 penaltyRate, uint256 windowEndBlock, bool inWindow)
  {
    IAeroV2Gauge gauge = IAeroV2Gauge(rewardPool());
    IAeroV2GaugeFactory.PenaltyConfig memory config = _penaltyConfig(address(gauge));
    uint256 lastDepositBlock = gauge.depositBlock(address(this));
    minStakeBlocks = config.minStakeBlocks;
    penaltyRate = config.penaltyRate;
    windowEndBlock = lastDepositBlock == 0 ? 0 : lastDepositBlock + config.minStakeBlocks;
    inWindow = gauge.isPenaltyActive(address(this));
  }

  /**
   * @notice Number of window lengths the strategy waits between gauge deposits while a window is configured.
   */
  function stakeSpacing() public view returns (uint256) {
    return getUint256(_STAKE_SPACING_SLOT);
  }

  /**
   * @notice Minimum number of blocks between the strategy's gauge deposits, whether or not Aero enforces a window.
   */
  function minStakeInterval() public view returns (uint256) {
    return getUint256(_MIN_STAKE_INTERVAL_SLOT);
  }

  /**
   * @notice Block of the strategy's last gauge deposit; 0 when nothing is staked.
   */
  function lastStakeBlock() public view returns (uint256) {
    return getUint256(_LAST_STAKE_BLOCK_SLOT);
  }

  /**
   * @notice True while governance keeps all LP out of the gauge (see setKeepUnstaked).
   */
  function keepUnstaked() public view returns (bool) {
    return getBoolean(_KEEP_UNSTAKED_SLOT);
  }

  /**
   * @notice Reward tokens held whose fees were already taken: what a failed compounding left for the next run, which
   * compounds it without taking fees on it again (0 after a successful compounding). Stays 0 when the reward token is
   * not one of the pool's tokens, since every sale then sells all of it.
   */
  function feePaidReward() public view returns (uint256) {
    return getUint256(_FEE_PAID_REWARD_SLOT);
  }

  /// @dev First block at which _stakeIdle may deposit again (0 when nothing is staked): minStakeInterval blocks after
  /// the strategy's own last deposit, and while Aero enforces a window, also stakeSpacing window lengths after the
  /// gauge's depositBlock. The interval cannot count from depositBlock: with no window, anyone can reset it for the
  /// strategy through depositFor, which would postpone staking indefinitely.
  function _nextStakeBlock(address gauge, IAeroV2GaugeFactory.PenaltyConfig memory config)
    internal
    view
    returns (uint256 next)
  {
    uint256 lastStake = lastStakeBlock();
    if (lastStake == 0) {
      return 0;
    }
    next = lastStake + minStakeInterval();
    if (config.minStakeBlocks > 0 && config.penaltyRate > 0) {
      uint256 windowSpacing = Math.max(1, stakeSpacing()) * config.minStakeBlocks;
      next = Math.max(next, IAeroV2Gauge(gauge).depositBlock(address(this)) + windowSpacing);
    }
  }

  function _rewardPoolBalance() internal view returns (uint256) {
    return IAeroV2Gauge(rewardPool()).balanceOf(address(this));
  }

  function _penaltyConfig(address gauge) internal view returns (IAeroV2GaugeFactory.PenaltyConfig memory) {
    return IAeroV2GaugeFactory(IAeroV2Gauge(gauge).gaugeFactory()).effectivePenaltyConfig(gauge);
  }

  /// @dev True when the vault runs doHardWork inside user deposits or withdrawals
  function _vaultRunsHardWorkForUsers() internal view returns (bool) {
    IVaultInvestFlags vault_ = IVaultInvestFlags(vault());
    return vault_.investOnDeposit() || vault_.compoundOnWithdraw();
  }

  /// @dev The pool's POOL_TYPE this strategy is for: "V2_VOLATILE" or "V2_STABLE"
  function _poolType() internal pure virtual returns (bytes32);

  // ==================== Governance ====================

  /**
   * @notice Sets how many window lengths to wait between gauge deposits while Aero enforces a window.
   * @dev Higher = less time inside a window (safer exits) but new LP waits longer to earn emissions.
   * MAX_STAKE_SPACING effectively stops re-staking until the window is removed.
   */
  function setStakeSpacing(uint256 _stakeSpacing) external onlyGovernance {
    require(_stakeSpacing >= 1 && _stakeSpacing <= MAX_STAKE_SPACING, "Invalid stake spacing");
    setUint256(_STAKE_SPACING_SLOT, _stakeSpacing);
    emit StakeSpacingChanged(_stakeSpacing);
  }

  /**
   * @notice Sets the minimum number of blocks between the strategy's gauge deposits, which applies even when Aero
   * enforces no window.
   * @dev Higher = a window that Aero switches on later is less likely to find a recent stake, but new LP waits longer to
   * earn emissions. 0 lets every hard work stake while there is no window. Outsiders can still make the stake look
   * recent while there is no window, by staking for the strategy through gauge.depositFor; nothing here can stop that.
   */
  function setMinStakeInterval(uint256 _minStakeInterval) external onlyGovernance {
    require(_minStakeInterval <= MAX_MIN_STAKE_INTERVAL, "Invalid stake interval");
    setUint256(_MIN_STAKE_INTERVAL_SLOT, _minStakeInterval);
    emit MinStakeIntervalChanged(_minStakeInterval);
  }

  /**
   * @notice Keeps all LP out of the gauge, as for a gauge Aero switched off, for when Aero stops paying without setting
   * the gauge's emission cap to 0 (for example a full shutdown): no new stakes, and the stake is taken out right after
   * the next successful claim. Turning it off lets the next hard work stake everything again.
   * @dev If claims fail, in this order: switch this on (otherwise a hard work may stake everything again); wait until
   * penaltyWindow() shows no window, since a gauge withdraw inside one forfeits penaltyRate of the unclaimed AERO (all
   * of it at Aero's default rate); then emergencyExit takes the stake out and continueInvesting resumes the hard
   * works, which keep compounding pool fees. The strategy still reads the gauge (balanceOf, isPenaltyActive,
   * gaugeFactory) whatever this is set to and staked or not, so a gauge whose views revert blocks the hard works,
   * emergencyExit, setGauge, withdrawAllToVault (the vault's withdrawAll, rebalance and setStrategy) and the vault's
   * share price (so user deposits and withdrawals too): only an upgrade of the strategy lifts that.
   */
  function setKeepUnstaked(bool _keepUnstaked) external onlyGovernance {
    setBoolean(_KEEP_UNSTAKED_SLOT, _keepUnstaked);
    emit KeepUnstakedChanged(_keepUnstaked);
  }

  /**
   * @notice Checks if a token is non-salvageable (i.e., cannot be removed from the strategy).
   */
  function unsalvagableTokens(address token) public view returns (bool) {
    return (token == rewardToken() || token == underlying());
  }

  /**
   * @notice Allows governance or the controller to salvage tokens that are not part of the core strategy.
   */
  function salvage(address recipient, address token, uint256 amount) external onlyControllerOrGovernance {
    require(!unsalvagableTokens(token), "Token is non-salvageable");
    IERC20(token).safeTransfer(recipient, amount);
  }

  /**
   * @notice Adds a reward token that is sold into the main reward token on each hard work.
   */
  function addRewardToken(address _token) external onlyGovernance {
    require(_token != underlying() && !isRewardToken(_token), "Invalid reward token");
    address[] memory current = rewardTokens();
    address[] memory updated = new address[](current.length + 1);
    for (uint256 i = 0; i < current.length; i++) {
      updated[i] = current[i];
    }
    updated[current.length] = _token;
    _setRewardTokens(updated);
    emit RewardTokenAdded(_token);
  }

  /**
   * @notice Removes an extra reward token (e.g. one that can no longer be sold).
   */
  function removeRewardToken(address _token) external onlyGovernance {
    require(_token != rewardToken() && isRewardToken(_token), "Invalid reward token");
    address[] memory current = rewardTokens();
    address[] memory updated = new address[](current.length - 1);
    uint256 j = 0;
    for (uint256 i = 0; i < current.length; i++) {
      if (current[i] != _token) {
        updated[j++] = current[i];
      }
    }
    _setRewardTokens(updated);
    emit RewardTokenRemoved(_token);
  }

  /**
   * @notice Moves the stake to a new gauge of the same pool. The next doHardWork stakes into it.
   * @dev Reverts if the old gauge's withdraw fails, so the stake is never left behind; emergencyExit can take it out
   * first.
   */
  function setGauge(address _newGauge) external onlyGovernance {
    require(IAeroV2Gauge(_newGauge).stakingToken() == underlying(), "Underlying mismatch");
    address oldGauge = rewardPool();
    _withdrawFromGauge(_rewardPoolBalance(), false);
    // Nothing is staked in the old gauge any more (no window): collect emissions deferred by a failed mint
    try IAeroV2Gauge(oldGauge).claimEmissions(address(this), address(this)) {} catch {}
    _setRewardPool(_newGauge);
    emit GaugeChanged(oldGauge, _newGauge);
  }

  /**
   * @notice Enables or disables the selling of rewards for the strategy.
   */
  function setSell(bool s) public onlyGovernance {
    _setSell(s);
  }

  /**
   * @notice Finalizes the strategy upgrade.
   */
  function finalizeUpgrade() external onlyGovernance {
    _finalizeUpgrade();
  }
}
