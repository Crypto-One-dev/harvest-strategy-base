// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/**
 * @title IAeroV2Pool
 * @notice Aero (ex-Aerodrome) Basic Volatile / Basic Stable pool; the pool itself is the LP token.
 */
interface IAeroV2Pool {
  /// @notice "V2_VOLATILE" (VolatilePool.sol) or "V2_STABLE" (StablePool.sol)
  function POOL_TYPE() external view returns (bytes32);

  function token0() external view returns (address);

  function token1() external view returns (address);

  function totalSupply() external view returns (uint256);

  function getReserves() external view returns (uint256 reserve0, uint256 reserve1, uint256 blockTimestampLast);

  /// @notice Swap output for `amountIn` of `tokenIn`, after the pool's base fee
  function getAmountOut(uint256 amountIn, address tokenIn) external view returns (uint256);

  /// @notice Mints LP to `to` for the tokens sent to the pool beforehand
  function mint(address to) external returns (uint256 liquidity);

  /// @notice Claims msg.sender's swap fees (earned on unstaked LP only) to `recipient`
  function claimFees(address recipient) external returns (uint256 amount0, uint256 amount1);
}
