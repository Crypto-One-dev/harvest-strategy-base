//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "./AerodromeV2VolatileStrategy.sol";

contract AerodromeV2VolatileStrategyMainnet_AERO_USDC is AerodromeV2VolatileStrategy {

  constructor() {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0xF634058dC94e6BF8e828E27621320C423bC8B18E); // vAMMV2-AERO/USDC
    address gauge = address(0xd424BA8ca9d4E278753DE76651a0095451e65cD1);
    address aero = address(0x3f5bF3EdAc59d650D8fDf9657a71F2f904A3a4Ee);
    AerodromeV2Strategy.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      gauge,
      aero
    );
    address[] memory rewards = new address[](1);
    rewards[0] = aero;
    _setRewardTokens(rewards);
  }
}
