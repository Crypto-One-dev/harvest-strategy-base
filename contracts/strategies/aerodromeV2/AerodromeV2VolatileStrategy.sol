//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "./AerodromeV2Strategy.sol";

/**
 * @title AerodromeV2VolatileStrategy
 * @dev AerodromeV2Strategy for Aero Basic Volatile pools (vAMMV2-*, x*y=k). All logic is shared with
 * AerodromeV2StableStrategy; initialization rejects any pool that is not a volatile one.
 */
contract AerodromeV2VolatileStrategy is AerodromeV2Strategy {
  function _poolType() internal pure override returns (bytes32) {
    return "V2_VOLATILE";
  }
}
