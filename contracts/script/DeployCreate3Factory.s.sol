// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {Script, console2} from "forge-std/Script.sol";
import {PoolmigoCreate3} from "contracts/periphery/PoolmigoCreate3.sol";

/**
 * @notice Deploys the PoolmigoCreate3 factory — run ONCE per chain, as the FIRST transaction of a
 * dedicated deployer account, so the factory lands at the same address everywhere (nonce 0).
 * Every later deterministic deployment keys off this address.
 *
 * Local anvil:
 *   forge script script/DeployCreate3Factory.s.sol --rpc-url http://127.0.0.1:8548 \
 *     --private-key $ANVIL_DEV_KEY --broadcast        # public test key — LOCAL ONLY
 *
 * Real network (keystore only — never a plaintext key):
 *   forge script script/DeployCreate3Factory.s.sol --rpc-url <rpc> \
 *     --account <keystoreName> --sender <address> --broadcast
 *
 * Prints `POOLMIGO_CREATE3_FACTORY=<address>` for script/DeployDeterministic.s.sol.
 */
contract DeployCreate3Factory is Script {
    function run() external returns (address factory) {
        vm.startBroadcast();
        uint256 nonce = vm.getNonce(msg.sender);
        if (nonce != 0) {
            console2.log(
                "WARNING: deployer nonce is", nonce, "-> factory address will NOT match a fresh-account deployment"
            );
        } else {
            console2.log("deployer nonce 0: factory address is chain-independent (same account on every chain)");
        }
        factory = address(new PoolmigoCreate3());
        vm.stopBroadcast();
        console2.log("POOLMIGO_CREATE3_FACTORY=%s", factory);
    }
}
