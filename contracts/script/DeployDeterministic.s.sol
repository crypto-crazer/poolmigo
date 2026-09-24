// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {Script, console2} from "forge-std/Script.sol";
import {Upgrades, Options} from "openzeppelin-foundry-upgrades/Upgrades.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {PoolmigoVaultUpgradeable} from "contracts/PoolmigoVaultUpgradeable.sol";
import {PoolmigoCreate3} from "contracts/periphery/PoolmigoCreate3.sol";

/**
 * @notice Deterministic vault deployment: the UUPS proxy lands on
 * `CREATE3_FACTORY.create3Address(SALT)` — the same address on every chain where the factory sits
 * at the same address — while the implementation is a plain per-chain CREATE (its address may
 * differ; the proxy stores it). Salt default: keccak256("poolmigo.vault.v1").
 *
 * Always `forge clean && forge build` first (the OZ validator needs a single fresh build-info).
 *
 *   CREATE3_FACTORY=0x... OWNER=0x... TREASURY=0x... FEE_BPS=1000 TOKENS=0x..,0x.. \
 *   GENESIS_SHARES=10000000000000000000000 MAX_TOTAL_SUPPLY=500000000000000000000000 \
 *   forge script script/DeployDeterministic.s.sol --rpc-url <rpc> \
 *     --account <keystoreName> --sender <address> --broadcast
 *
 * Env: CREATE3_FACTORY, OWNER, TREASURY, FEE_BPS, TOKENS (comma-separated), GENESIS_SHARES (K, non-zero),
 *      MAX_TOTAL_SUPPLY (0 = uncapped);
 *      SALT (bytes32, optional); LABEL (optional log tag, so two runs can be diffed).
 */
contract DeployDeterministic is Script {
    struct Params {
        address owner;
        address treasury;
        uint16 feeBps;
        address[] tokens;
        uint256 genesisShares;
        uint256 maxTotalSupply;
        bytes32 salt;
        string label;
    }

    function run() external returns (address proxy, address implementation) {
        Params memory p = _readParams();
        PoolmigoCreate3 factory = PoolmigoCreate3(vm.envAddress("CREATE3_FACTORY"));
        address predicted = factory.create3Address(p.salt);
        bytes memory initData = abi.encodeCall(
            PoolmigoVaultUpgradeable.initialize,
            (p.owner, p.tokens, p.treasury, p.feeBps, p.genesisShares, p.maxTotalSupply)
        );

        // OZ upgrade-safety validation (needs a single fresh build-info — clean-build first).
        Options memory opts;
        Upgrades.validateImplementation("PoolmigoVaultUpgradeable.sol", opts);

        vm.startBroadcast();
        implementation = address(new PoolmigoVaultUpgradeable());
        bytes memory proxyCode = abi.encodePacked(type(ERC1967Proxy).creationCode, abi.encode(implementation, initData));
        proxy = factory.deploy(p.salt, proxyCode);
        vm.stopBroadcast();

        _verify(p, proxy, implementation, predicted);
        _log(p, proxy, implementation, address(factory), predicted);
    }

    function _readParams() internal view returns (Params memory p) {
        p.owner = vm.envAddress("OWNER");
        p.treasury = vm.envAddress("TREASURY");
        p.feeBps = uint16(vm.envUint("FEE_BPS"));
        p.tokens = vm.envAddress("TOKENS", ",");
        p.genesisShares = vm.envUint("GENESIS_SHARES");
        p.maxTotalSupply = vm.envUint("MAX_TOTAL_SUPPLY");
        p.salt = vm.envOr("SALT", keccak256("poolmigo.vault.v1"));
        p.label = vm.envOr("LABEL", string("deploy"));
    }

    function _verify(Params memory p, address proxy, address implementation, address predicted) internal view {
        require(proxy == predicted, "CREATE3 address mismatch");
        require(Upgrades.getImplementationAddress(proxy) == implementation, "EIP-1967 slot mismatch");
        PoolmigoVaultUpgradeable vault = PoolmigoVaultUpgradeable(proxy);
        require(
            vault.owner() == p.owner && vault.treasury() == p.treasury && vault.performanceFeeBps() == p.feeBps
                && vault.genesisShares() == p.genesisShares && vault.maxTotalSupply() == p.maxTotalSupply,
            "initialize state mismatch"
        );
    }

    function _log(Params memory p, address proxy, address implementation, address factory, address predicted)
        internal
        view
    {
        console2.log("[%s] POOLMIGO_PROXY=%s", p.label, proxy);
        console2.log("[%s] POOLMIGO_IMPL=%s", p.label, implementation);
        console2.log("[%s] POOLMIGO_FACTORY=%s", p.label, factory);
        console2.log("[%s] POOLMIGO_PREDICTED=%s", p.label, predicted);
    }
}
