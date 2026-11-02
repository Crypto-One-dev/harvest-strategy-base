// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/**
 * @title IAeroV2LeafVoter
 * @notice Aero LeafVoter: mints the emissions claimed from gauges.
 */
interface IAeroV2LeafVoter {
  /// @notice Chain status: 1 Active, 2 Paused (emission mints revert), 3 Suspended, 4 Sunset. Aero governance only.
  function setChainStatus(uint8 status) external;
}
