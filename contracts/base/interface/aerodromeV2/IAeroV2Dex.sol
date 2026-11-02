// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/**
 * @title IAeroV2Dex
 * @notice Harvest UniversalLiquidator adapter that swaps through new Aero basic pools.
 */
interface IAeroV2Dex {
  /// @notice Routes swaps between `token0` and `token1` through the pool of `factory` (volatile or stable)
  function pairSetup(address token0, address token1, address factory) external;

  function factory(address token0, address token1) external view returns (address);
}
