// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/**
 * @title IAeroV2Gauge
 * @notice Gauge of an Aero (ex-Aerodrome) Basic Volatile / Basic Stable pool.
 */
interface IAeroV2Gauge {
  event Deposit(address indexed _caller, address indexed _account, uint256 _amount);
  event Withdraw(address indexed _caller, address indexed _account, uint256 _amount);
  event EmissionsClaimed(address indexed _account, address indexed _recipient, uint256 _rewardAmount);
  event EarlyWithdrawPenalty(address indexed _account, uint256 _penalty);
  event EmissionsDeferred(address indexed _account, uint256 _rewardAmount);
  event DeferredEmissionsClaimed(address indexed _account, address indexed _recipient, uint256 _amount);
  event EmergencyWithdraw(address indexed _account, uint256 _amount);

  /// @notice LP token staked in this gauge
  function stakingToken() external view returns (address);

  /// @notice Gauge factory holding this gauge's penalty configuration
  function gaugeFactory() external view returns (address);

  /// @notice LP staked by `account`
  function balanceOf(address account) external view returns (uint256);

  /// @notice Block of `account`'s last deposit; 0 when it has nothing staked
  function depositBlock(address account) external view returns (uint256);

  /// @notice True while a claim or withdraw by `account` would forfeit its unclaimed emissions
  function isPenaltyActive(address account) external view returns (bool);

  /// @notice Unclaimed emissions of `account` after any active penalty (0 inside a 100% penalty window)
  function earned(address account) external view returns (uint256);

  /// @notice Emissions snapshotted for `account` at its last deposit (not yet claimed)
  function rewards(address account) external view returns (uint256);

  /// @notice Reward-per-token checkpoint of `account`
  function userRewardPerTokenPaid(address account) external view returns (uint256);

  /// @notice Reward-per-token accumulator projected to the current block
  function projectedRewardPerToken() external view returns (uint256);

  /// @notice Emissions of `account` whose mint failed; paid, without penalty, by its next claim
  function deferredEmissions(address account) external view returns (uint256);

  /// @notice Stakes `amount` LP for msg.sender and restarts its penalty window
  function deposit(uint256 amount) external;

  /// @notice Unstakes `amount` LP; claims ALL unclaimed emissions first (penalized inside the window)
  function withdraw(uint256 amount) external;

  /// @notice Claims `account`'s emissions to `recipient` (penalized inside the window); reverts if minting fails
  function claimEmissions(address account, address recipient) external;

  /// @notice Unstakes without claiming; only works while enabled on the gauge factory
  function emergencyWithdraw(uint256 amount) external;
}
