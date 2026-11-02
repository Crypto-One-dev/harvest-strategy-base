// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/**
 * @title IVaultInvestFlags
 * @notice Harvest vault settings that make user deposits/withdrawals run the strategy's doHardWork (VaultV1.sol).
 */
interface IVaultInvestFlags {
  function investOnDeposit() external view returns (bool);

  function compoundOnWithdraw() external view returns (bool);
}
