// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../../base/interface/IUniversalLiquidator.sol";
import "../../base/upgradability/BaseUpgradeableStrategy.sol";
import "../../base/interface/aerodromeV2/IAeroV2Gauge.sol";
import "../../base/interface/aerodromeV2/IAeroV2GaugeFactory.sol";
import "../../base/interface/aerodromeV2/IAeroV2Pool.sol";
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
  /// @dev Fraction of reserve0 used to probe the pool's marginal price when splitting rewards
  uint256 internal constant PRICE_PROBE_DIVISOR = 10_000;
  uint256 internal constant DEFAULT_STAKE_SPACING = 10;
  uint256 internal constant MAX_STAKE_SPACING = 1_000;

  // additional storage slots (on top of BaseUpgradeableStrategy ones) are defined here
  bytes32 internal constant _STAKE_SPACING_SLOT = 0xdb0c127b40d22d3cc92da10472a99818c8393b96aea0d59174d5e551aad38274;

  event GaugeChanged(address oldGauge, address newGauge);
  event HardWorkSkipped();
  event ClaimSkipped(uint256 windowEndBlock);
  event ClaimFailed(bytes reason);
  event StakeSkipped(uint256 idleAmount);
  event StakeFailed(bytes reason);
  event LiquidationFailed(bytes reason);
  event GaugeExitFailed(bytes reason);
  event StakeSpacingChanged(uint256 stakeSpacing);
  event RewardTokenRemoved(address token);

  constructor() BaseUpgradeableStrategy() {
    assert(_STAKE_SPACING_SLOT == bytes32(uint256(keccak256("eip1967.strategyStorage.stakeSpacing")) - 1));
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
  }

  /**
   * @notice Claims AERO, compounds it into LP and stakes idle LP, without ever losing rewards to the penalty window.
   * @dev Inside a penalty window it skips the claim and the stake (no revert); rewards stay in the gauge until a
   * later run. Fee claims, liquidation and the gauge deposit are isolated so none of them can block the others.
   */
  function doHardWork() external restricted {
    // User deposits/withdrawals must never reach the gauge: each deposit would restart the penalty window
    if (msg.sender == vault() && _vaultRunsHardWorkForUsers()) {
      emit HardWorkSkipped();
      return;
    }
    require(!pausedInvesting(), "Action blocked as the strategy is in emergency state");

    try IAeroV2Pool(underlying()).claimFees(address(this)) {} catch {}
    bool claimed = _claimRewards();
    try this.liquidateRewards() {} catch (bytes memory reason) {
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
      emit ClaimFailed(reason);
      return false;
    }
  }

  function _stakeIdle(bool claimed) internal {
    address underlying_ = underlying();
    uint256 idle = IERC20(underlying_).balanceOf(address(this));
    if (idle == 0) {
      return;
    }
    address gauge = rewardPool();
    IAeroV2GaugeFactory factory = IAeroV2GaugeFactory(IAeroV2Gauge(gauge).gaugeFactory());
    IAeroV2GaugeFactory.PenaltyConfig memory config = factory.effectivePenaltyConfig(gauge);
    if (config.minStakeBlocks > 0 && config.penaltyRate > 0) {
      if (!claimed || block.number < _nextStakeBlock(gauge, config.minStakeBlocks)) {
        emit StakeSkipped(idle);
        return;
      }
    }
    // A switched-off gauge pays no AERO and its stakers get no pool fees: keep the LP unstaked instead
    if (factory.emissionCap(gauge) == 0) {
      emit StakeSkipped(idle);
      return;
    }
    IERC20(underlying_).safeApprove(gauge, 0);
    IERC20(underlying_).safeApprove(gauge, idle);
    try IAeroV2Gauge(gauge).deposit(idle) {} catch (bytes memory reason) {
      IERC20(underlying_).safeApprove(gauge, 0);
      emit StakeFailed(reason);
    }
  }

  /**
   * @dev Sells any extra reward tokens for the main reward token, takes the protocol fees, then turns the rest into LP.
   */
  function _liquidateRewards() internal {
    if (!sell()) {
      emit ProfitsNotCollected(sell(), false);
      return;
    }

    address _rewardToken = rewardToken();
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
        IERC20(token).safeApprove(_universalLiquidator, 0);
        emit LiquidationFailed(reason);
      }
    }

    uint256 rewardBalance = IERC20(_rewardToken).balanceOf(address(this));
    if (rewardBalance < MIN_REWARD) {
      return;
    }
    _notifyProfitInRewardToken(_rewardToken, rewardBalance);
    uint256 remainingRewardBalance = IERC20(_rewardToken).balanceOf(address(this));
    if (remainingRewardBalance < MIN_REWARD) {
      return;
    }
    _addLiquidity(_rewardToken, remainingRewardBalance, _universalLiquidator);
  }

  function _addLiquidity(address _rewardToken, uint256 _amount, address _universalLiquidator) internal {
    IAeroV2Pool pool = IAeroV2Pool(underlying());
    address token0 = pool.token0();
    address token1 = pool.token1();

    (uint256 reserve0, uint256 reserve1,) = pool.getReserves();
    if (reserve0 == 0 || reserve1 == 0) {
      return;
    }
    uint256 value0 = reserve1;
    uint256 probe = reserve0 / PRICE_PROBE_DIVISOR;
    if (probe > 0) {
      uint256 probeOut = pool.getAmountOut(probe, token0);
      if (probeOut > 0) {
        value0 = probeOut * PRICE_PROBE_DIVISOR;
      }
    }
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

    (reserve0, reserve1,) = pool.getReserves();
    uint256 amount0 = IERC20(token0).balanceOf(address(this));
    uint256 amount1 = IERC20(token1).balanceOf(address(this));
    uint256 amount1Optimal = amount0 * reserve1 / reserve0;
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

  function withdrawToVault(uint256 _amount) public restricted {
    address underlying_ = underlying();
    uint256 idle = IERC20(underlying_).balanceOf(address(this));
    if (_amount > idle) {
      _withdrawFromGauge(Math.min(_rewardPoolBalance(), _amount - idle), true);
    }
    IERC20(underlying_).safeTransfer(vault(), _amount);
  }

  /**
   * @notice Unstakes everything and sends all underlying to the vault. Used by vault.withdrawAll, rebalance,
   * setStrategy (migration) and the last-share withdrawal, so it must always work immediately.
   */
  function withdrawAllToVault() public restricted {
    address gauge = rewardPool();
    _withdrawFromGauge(_rewardPoolBalance(), true);
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
   * @notice Pauses investing and unstakes everything; a genuine gauge failure does not undo the pause.
   */
  function emergencyExit() public onlyGovernance {
    _setPausedInvesting(true);
    _withdrawFromGauge(_rewardPoolBalance(), false);
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
   * If gauge.withdraw itself fails on Aero's side, falls back to emergencyWithdraw when Aero has enabled it.
   * A failure caused by the caller's gas limit is always re-raised, so it can never trigger that fallback.
   * @param revertOnFailure Re-raise an Aero-side failure, or emit GaugeExitFailed and return false (emergencyExit).
   */
  function _withdrawFromGauge(uint256 amount, bool revertOnFailure) internal returns (bool) {
    if (amount == 0) {
      return true;
    }
    IAeroV2Gauge gauge = IAeroV2Gauge(rewardPool());
    try gauge.withdraw(amount) {
      return true;
    } catch (bytes memory reason) {
      if (_isGasFailure(reason)) {
        _revertWith(reason);
      }
      if (IAeroV2GaugeFactory(gauge.gaugeFactory()).emergencyWithdrawEnabled()) {
        try gauge.emergencyWithdraw(amount) {
          return true;
        } catch (bytes memory emergencyReason) {
          reason = emergencyReason;
        }
      }
      if (revertOnFailure) {
        _revertWith(reason);
      }
      emit GaugeExitFailed(reason);
      return false;
    }
  }

  /// @dev True when the gauge call failed because of the caller's gas limit: it ran out of gas (no revert data),
  /// or Aero's own gas check rejected it (the gauge tape needs more than gaugeTapeGasLimit, set by Aero)
  function _isGasFailure(bytes memory reason) internal pure returns (bool) {
    return reason.length == 0
      || keccak256(reason) == keccak256(abi.encodeWithSelector(IAeroV2GaugeFactory.InsufficientGasForCall.selector));
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

  /// @dev First block at which _stakeIdle may deposit again: stakeSpacing window lengths after the last deposit
  function _nextStakeBlock(address gauge, uint256 minStakeBlocks) internal view returns (uint256) {
    uint256 lastDepositBlock = IAeroV2Gauge(gauge).depositBlock(address(this));
    if (lastDepositBlock == 0) {
      return 0;
    }
    return lastDepositBlock + Math.max(1, stakeSpacing()) * minStakeBlocks;
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
   */
  function setGauge(address _newGauge) external onlyGovernance {
    require(IAeroV2Gauge(_newGauge).stakingToken() == underlying(), "Underlying mismatch");
    address oldGauge = rewardPool();
    _withdrawFromGauge(_rewardPoolBalance(), true);
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
