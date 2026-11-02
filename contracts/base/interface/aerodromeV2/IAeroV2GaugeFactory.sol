// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/**
 * @title IAeroV2GaugeFactory
 * @notice Factory of Aero V2 gauges; holds the minimum staking period configuration.
 */
interface IAeroV2GaugeFactory {
  /// @notice Raised by recordGaugeTape (called on every gauge deposit, withdraw and claim) when
  /// gasleft() <= gaugeTapeGasLimit, i.e. when the caller sent too little gas
  error InsufficientGasForCall();

  struct PenaltyConfig {
    uint256 minStakeBlocks; // window length in blocks; 0 = no window
    uint256 penaltyRate;    // share of unclaimed emissions forfeited inside the window, in PIPS (1_000_000 = 100%)
  }

  /// @notice Penalty configuration a gauge applies: its own minStakeBlocks if set, else the factory default
  function effectivePenaltyConfig(address gauge) external view returns (PenaltyConfig memory);

  /// @notice Whether gauges of this factory allow emergencyWithdraw
  function emergencyWithdrawEnabled() external view returns (bool);

  /// @notice Max AERO per second a gauge can emit; 0 means the gauge is switched off
  function emissionCap(address gauge) external view returns (uint128);

  /// @notice Sets a gauge's minimum staking period in blocks (0 = use the factory default). Aero governance only.
  function setMinStakeBlocks(address gauge, uint256 minStakeBlocks) external;

  /// @notice Enables or disables emergencyWithdraw on all gauges of this factory. Aero governance only.
  function setEmergencyWithdrawEnabled(bool enabled) external;

  /// @notice Contract recording gauge reward checkpoints on every gauge deposit, withdraw and claim
  function gaugeTape() external view returns (address);

  /// @notice Gas reserved for the gauge tape; calls arriving with less gas revert InsufficientGasForCall
  function gaugeTapeGasLimit() external view returns (uint32);

  /// @notice Sets the gauge tape and its gas limit. Aero governance only.
  function setGaugeTape(address gaugeTape, uint32 gasLimit) external;
}
