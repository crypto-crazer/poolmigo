// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {Script, console2} from "forge-std/Script.sol";
import {Upgrades} from "openzeppelin-foundry-upgrades/Upgrades.sol";
import {PoolmigoVaultUpgradeable} from "contracts/PoolmigoVaultUpgradeable.sol";
import {MockPositionAdapter} from "test/mocks/MockPositionAdapter.sol";
import {MockToken} from "test/mocks/MockToken.sol";

/**
 * @notice One-shot local demo stack for Anvil — the shared dev chain for frontend/backend work.
 *
 * Deploys mock USDG + mock WETH, the vault UUPS proxy, TWO mock position adapters (stand-ins for
 * Uniswap V3 + V4 pools), makes the owner-only genesis deposit (mints K), has the keeper deploy part of the capital into
 * both adapters, seeds harvestable fees, and writes `shared/deployment.local.json` (the single
 * source of truth for addresses consumed by frontend/ and backend/).
 *
 * Usage (with anvil running):
 *   anvil --port 8547 --chain-id 46630
 *   forge clean && forge build          # OZ plugin requirement: fresh single build-info
 *   forge script script/DemoLocal.s.sol --rpc-url http://127.0.0.1:8547 --broadcast \
 *     --private-key $ANVIL_DEV_KEY      # anvil #0 — LOCAL ONLY public test key
 *
 * The dev keys/accounts below are the publicly known Anvil defaults. They are inert and must
 * NEVER be funded on a real network. Run against a FRESH anvil (re-running against a used chain
 * would deploy a second stack; that is harmless but confusing).
 */
contract DemoLocal is Script {
    /* ================ Anvil dev accounts (public, well-known — LOCAL ONLY) ================ */
    address internal constant OWNER = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266; // #0, deployer
    address internal constant KEEPER = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8; // #1, keeper service
    address internal constant DEMO_USER = 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC; // #2, frontend tester
    uint256 internal constant ANVIL_KEY_1 = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d; // #1 — LOCAL ONLY

    uint16 internal constant FEE_BPS = 1000; // 10% performance fee
    /// @dev Genesis K: demo stand-in for the team's one-time off-chain valuation of the seed basket.
    uint256 internal constant GENESIS_SHARES = 10_000e18;
    /// @dev migoLP supply cap (PRD F1.2), raised in stages by the owner. 0 would mean uncapped.
    uint256 internal constant MAX_TOTAL_SUPPLY = 500_000e18;

    function run() external {
        /* ------------- phase 1: deploy stack + bootstrap deposit (deployer = anvil #0) ------------- */
        vm.startBroadcast();

        MockToken usdg = new MockToken("Mock USDG", "mUSDG", 6);
        MockToken weth = new MockToken("Mock WETH", "mWETH", 18);

        address[] memory basket = new address[](2);
        basket[0] = address(usdg);
        basket[1] = address(weth);

        address vault = Upgrades.deployUUPSProxy(
            "PoolmigoVaultUpgradeable.sol",
            abi.encodeCall(
                PoolmigoVaultUpgradeable.initialize, (OWNER, basket, OWNER, FEE_BPS, GENESIS_SHARES, MAX_TOTAL_SUPPLY)
            )
        );

        MockPositionAdapter adapterV3 =
            new MockPositionAdapter(basket, vault, bytes32("uniswap-v3"), bytes32("mUSDG/mWETH 0.05%"));
        MockPositionAdapter adapterV4 =
            new MockPositionAdapter(basket, vault, bytes32("uniswap-v4"), bytes32("mUSDG/mWETH 0.30%"));

        PoolmigoVaultUpgradeable vaultC = PoolmigoVaultUpgradeable(vault);
        vaultC.addAdapter(adapterV3);
        vaultC.addAdapter(adapterV4);
        vaultC.setKeeper(KEEPER, true);

        // Fund the demo actors generously.
        usdg.mint(OWNER, 1_000_000e6);
        weth.mint(OWNER, 500e18);
        usdg.mint(DEMO_USER, 250_000e6);
        weth.mint(DEMO_USER, 50e18);

        // Genesis deposit — owner-only (this broadcast is anvil #0 == OWNER); defines the basket and mints
        // exactly GENESIS_SHARES (K), independent of the amounts.
        usdg.approve(vault, type(uint256).max);
        weth.approve(vault, type(uint256).max);
        uint256[] memory boot = new uint256[](2);
        boot[0] = 100_000e6;
        boot[1] = 10e18;
        vaultC.deposit(basket, boot, GENESIS_SHARES, OWNER);

        vm.stopBroadcast();

        /* ------- phase 2: keeper deploys capital into both adapters + seeds fees (anvil #1) ------- */
        vm.startBroadcast(ANVIL_KEY_1);

        uint256[] memory intoV3 = new uint256[](2);
        intoV3[0] = 50_000e6;
        intoV3[1] = 5e18;
        vaultC.deployTo(adapterV3, intoV3);

        uint256[] memory intoV4 = new uint256[](2);
        intoV4[0] = 25_000e6;
        intoV4[1] = 2.5e18;
        vaultC.deployTo(adapterV4, intoV4);

        // Pretend both positions accrued trading fees (harvestable via rebalance()).
        uint256[] memory feesV3 = new uint256[](2);
        feesV3[0] = 250e6;
        feesV3[1] = 0.05e18;
        adapterV3.simulateFees(feesV3);

        uint256[] memory feesV4 = new uint256[](2);
        feesV4[0] = 100e6;
        feesV4[1] = 0.02e18;
        adapterV4.simulateFees(feesV4);

        vm.stopBroadcast();

        /* ------------------------------ logs + shared/deployment.local.json ------------------------------ */
        console2.log("== Poolmigo local demo stack ==");
        console2.log("chainId          :", block.chainid);
        console2.log("vault (proxy)    :", vault);
        console2.log("implementation   :", Upgrades.getImplementationAddress(vault));
        console2.log("mUSDG            :", address(usdg));
        console2.log("mWETH            :", address(weth));
        console2.log("adapter (v3 mock):", address(adapterV3));
        console2.log("adapter (v4 mock):", address(adapterV4));
        console2.log("owner            :", OWNER);
        console2.log("keeper           :", KEEPER);
        console2.log("demo user        :", DEMO_USER);
        console2.log("genesis shares   :", vaultC.genesisShares());
        console2.log("totalSupply      :", vaultC.totalSupply());
        console2.log("maxTotalSupply   :", vaultC.maxTotalSupply());
        console2.log("symbol           :", vaultC.symbol());

        string memory obj = "deployment";
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeString(obj, "rpcUrl", "http://127.0.0.1:8547");
        vm.serializeAddress(obj, "vault", vault);
        vm.serializeAddress(obj, "implementation", Upgrades.getImplementationAddress(vault));
        vm.serializeAddress(obj, "usdg", address(usdg));
        vm.serializeAddress(obj, "weth", address(weth));
        vm.serializeAddress(obj, "adapterV3", address(adapterV3));
        vm.serializeAddress(obj, "adapterV4", address(adapterV4));
        vm.serializeAddress(obj, "owner", OWNER);
        vm.serializeAddress(obj, "keeper", KEEPER);
        string memory json = vm.serializeAddress(obj, "demoUser", DEMO_USER);
        vm.writeJson(json, "../shared/deployment.local.json");
        console2.log("wrote ../shared/deployment.local.json");
    }
}
