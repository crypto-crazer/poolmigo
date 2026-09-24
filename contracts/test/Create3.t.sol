// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {Test} from "forge-std/Test.sol";
import {Upgrades, Options} from "openzeppelin-foundry-upgrades/Upgrades.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {PoolmigoCreate3, Create3Dispatcher} from "contracts/periphery/PoolmigoCreate3.sol";
import {PoolmigoVaultUpgradeable} from "contracts/PoolmigoVaultUpgradeable.sol";
import {MockToken} from "test/mocks/MockToken.sol";

/// @notice CREATE3 factory + deterministic vault deployment. The cross-chain half of the proof
///         (two fresh anvils, shifted nonces) lives in script/deterministic-address-check.sh.
contract Create3Test is Test {
    PoolmigoCreate3 internal factory;
    bytes32 internal constant SALT = keccak256("poolmigo.vault.v1");

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");

    function setUp() public {
        factory = new PoolmigoCreate3();
    }

    function _mockTokenCode() internal pure returns (bytes memory) {
        return abi.encodePacked(type(MockToken).creationCode, abi.encode("Mock USDG", "USDG", uint8(6)));
    }

    /*//////////////////////////////////////////////////////////////
                            1. ADDRESS MATH
    //////////////////////////////////////////////////////////////*/

    /// @dev Independent derivation: dispatcher = CREATE2(factory, salt, dispatcherInitCode);
    ///      target = keccak256(0xd6 0x94 ++ dispatcher ++ 0x01)[12:].
    function test_PredictedAddressMatchesIndependentFormula() public view {
        address dispatcher =
            vm.computeCreate2Address(SALT, keccak256(type(Create3Dispatcher).creationCode), address(factory));
        address expected = address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xd6), bytes1(0x94), dispatcher, bytes1(0x01)))))
        );

        assertEq(factory.dispatcherAddress(SALT), dispatcher, "dispatcher formula");
        assertEq(factory.create3Address(SALT), expected, "final address formula");
    }

    function test_DeployLandsAtPredictedAddress() public {
        address predicted = factory.create3Address(SALT);
        address deployed = factory.deploy(SALT, _mockTokenCode());

        assertEq(deployed, predicted, "actual == predicted");
        assertGt(predicted.code.length, 0, "code present");
        assertEq(MockToken(predicted).symbol(), "USDG", "constructor ran");
    }

    /*//////////////////////////////////////////////////////////////
                            2. SALT SEMANTICS
    //////////////////////////////////////////////////////////////*/

    function test_SameSaltTwiceReverts() public {
        factory.deploy(SALT, _mockTokenCode());
        vm.expectRevert(
            abi.encodeWithSelector(PoolmigoCreate3.Create3__SaltAlreadyUsed.selector, factory.dispatcherAddress(SALT))
        );
        factory.deploy(SALT, _mockTokenCode());
    }

    function test_DifferentSaltsDifferentAddresses() public {
        bytes32 saltA = keccak256("poolmigo.vault.v1");
        bytes32 saltB = keccak256("poolmigo.vault.v2");
        assertTrue(factory.create3Address(saltA) != factory.create3Address(saltB), "salts are namespaces");

        address a = factory.deploy(saltA, _mockTokenCode());
        address b = factory.deploy(saltB, _mockTokenCode());
        assertTrue(a != b, "both deployed, distinct");
    }

    /*//////////////////////////////////////////////////////////////
                    3. CALLER / NONCE INDEPENDENCE (LOCAL)
    //////////////////////////////////////////////////////////////*/

    function test_CallerAndNonceDoNotAffectAddress() public {
        address predicted = factory.create3Address(SALT);

        address alice = makeAddr("alice");
        vm.deal(alice, 1 ether);
        for (uint256 i; i < 5; ++i) {
            vm.prank(alice);
            (bool ok,) = address(0xBEEF).call{value: 1}("");
            assertTrue(ok);
        }

        vm.prank(alice);
        address deployed = factory.deploy(SALT, _mockTokenCode());
        assertEq(deployed, predicted, "caller + its nonce are irrelevant");
    }

    function test_DispatcherLockedToFactory() public {
        factory.deploy(SALT, _mockTokenCode());
        Create3Dispatcher dispatcher = Create3Dispatcher(factory.dispatcherAddress(SALT));
        assertEq(dispatcher.factory(), address(factory), "factory recorded");

        vm.expectRevert(Create3Dispatcher.Create3Dispatcher__Unauthorized.selector);
        dispatcher.dispatch(hex"00");
    }

    /*//////////////////////////////////////////////////////////////
                    4. FULL VAULT STACK VIA CREATE3
    //////////////////////////////////////////////////////////////*/

    /// @dev Also proves the initializer's arg-only semantics: it runs with msg.sender == dispatcher
    ///      (atomic deploy+initialize inside the proxy constructor), yet state comes from the args.
    function test_VaultProxyDeploysDeterministicallyAndInitializes() public {
        MockToken usdg = new MockToken("Mock USDG", "USDG", 6);
        MockToken weth = new MockToken("Mock WETH", "WETH", 18);
        address[] memory basket = new address[](2);
        basket[0] = address(usdg);
        basket[1] = address(weth);

        bytes memory initData = abi.encodeCall(
            PoolmigoVaultUpgradeable.initialize, (owner, basket, treasury, uint16(1500), 10_000e18, 500_000e18)
        );
        Options memory opts;
        Upgrades.validateImplementation("PoolmigoVaultUpgradeable.sol", opts);
        address implementation = address(new PoolmigoVaultUpgradeable());

        address predicted = factory.create3Address(SALT);
        bytes memory proxyCode = abi.encodePacked(type(ERC1967Proxy).creationCode, abi.encode(implementation, initData));
        address proxy = factory.deploy(SALT, proxyCode);

        assertEq(proxy, predicted, "proxy at deterministic address");

        PoolmigoVaultUpgradeable vault = PoolmigoVaultUpgradeable(proxy);
        assertEq(vault.owner(), owner);
        assertEq(vault.treasury(), treasury);
        assertEq(vault.performanceFeeBps(), 1500);
        assertEq(vault.genesisShares(), 10_000e18);
        assertEq(vault.maxTotalSupply(), 500_000e18);
        assertEq(vault.adapterCount(), 0);
        assertEq(vault.tokens().length, 2);
        assertEq(Upgrades.getImplementationAddress(proxy), implementation, "EIP-1967 slot");
    }
}
