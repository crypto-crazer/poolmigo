// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {PoolmigoVaultUpgradeable} from "contracts/PoolmigoVaultUpgradeable.sol";
import {IPositionAdapter} from "contracts/interfaces/IPositionAdapter.sol";
import {MockToken} from "test/mocks/MockToken.sol";

/**
 * @title  Spot-read sandwich PoC (research)
 * @notice Companion to `research/spot-read/BRIEF.md`. Property under test:
 *         if an adapter's `position()` composition is read from a SPOT price (not time-averaged),
 *         a depositor who manipulates that price before `deposit` and restores it afterwards can
 *         NEVER increase their claim. Even with a FREE manipulation (zero swap cost — the strongest
 *         possible assumption for the attacker), the round trip strictly loses
 *         `eps * m/(1+m)` with `eps = L * (sqrtP - sqrtP')^2 / sqrtP'`; an instant round trip loses
 *         nothing but gain is impossible. The epsilon flows to the pre-existing holders.
 *         Swap fees / LVR would make every case strictly worse — see the Python sim for economics.
 *
 * @dev    The mock models the pool side as paying exactly `f(current price)` (exact for a real v3
 *         position: its token composition depends only on the current price, not history) and mints
 *         to avoid replaying swap history. Both tokens are 18dp; the decimals/rounding angle is
 *         covered in the Python sim.
 *
 *         Batch 2 (2026-09-24): genesis is now owner-gated and mints the constant K (`GENESIS_K`), and
 *         deposits price with virtual shares/assets. The seed is funded by `owner` with `alice` as the
 *         receiver, so alice remains the incumbent holder and every conclusion below is unchanged.
 *         K is pinned to the old share scale (see `GENESIS_K`); the virtual terms (VS = VA = 1) move
 *         the numbers by ~1e-20 relative, far inside the tolerances.
 */
contract SpotCompositionAdapter is IPositionAdapter {
    using SafeERC20 for IERC20;

    uint256 internal constant W = 1e18; // sqrt-price scale: 1e18 == sqrt(1)

    address public immutable vault;
    address public immutable tokenX;
    address public immutable tokenY;
    uint256 public immutable sqrtA; // range lower bound (scaled by W)
    uint256 public immutable sqrtB; // range upper bound (scaled by W)
    uint256 public immutable L; // liquidity

    /// @dev Manipulable SPOT state (scaled by W). `setSqrtPrice` is the attacker's free knob.
    uint256 public sqrtP;

    /// @dev Remaining liquidity: withdrawals remove their slice of the position (a real position
    ///      keeps paying f(current price) of what is LEFT, not of the original size).
    uint256 public liquidity;

    error OnlyVault();

    constructor(
        address vault_,
        address tokenX_,
        address tokenY_,
        uint256 sqrtA_,
        uint256 sqrtB_,
        uint256 L_,
        uint256 sqrtP_
    ) {
        vault = vault_;
        tokenX = tokenX_;
        tokenY = tokenY_;
        sqrtA = sqrtA_;
        sqrtB = sqrtB_;
        L = L_;
        liquidity = L_;
        sqrtP = sqrtP_;
    }

    /// @notice Free price manipulation (swap costs deliberately unmodeled — upper bound for the attacker).
    function setSqrtPrice(uint256 t) external {
        sqrtP = t;
    }

    /// @dev v3 composition of the REMAINING liquidity in [A, B] at sqrt price s (all scaled by W).
    function compositionAt(uint256 s) public view returns (uint256 x, uint256 y) {
        (x, y) = _comp(s, liquidity);
    }

    function _comp(uint256 s, uint256 l) internal view returns (uint256 x, uint256 y) {
        if (s < sqrtA) {
            x = l * (sqrtB - sqrtA) * W / (sqrtA * sqrtB);
        } else if (s > sqrtB) {
            y = l * (sqrtB - sqrtA) / W;
        } else {
            x = l * (sqrtB - s) * W / (s * sqrtB);
            y = l * (s - sqrtA) / W;
        }
    }

    /*//////////////////////////////////////////////////////////////
                            IPositionAdapter
    //////////////////////////////////////////////////////////////*/

    function dex() external pure returns (bytes32) {
        return keccak256("UNISWAP_V3");
    }

    function poolId() external pure returns (bytes32) {
        return keccak256("spot-read-poc");
    }

    function position() public view returns (address[] memory tokens, uint256[] memory amounts) {
        tokens = new address[](2);
        tokens[0] = tokenX;
        tokens[1] = tokenY;
        amounts = new uint256[](2);
        (amounts[0], amounts[1]) = compositionAt(sqrtP);
    }

    function deploy(uint256[] calldata amounts) external returns (address[] memory tokens, uint256[] memory deployed) {
        if (msg.sender != vault) revert OnlyVault();
        tokens = new address[](2);
        tokens[0] = tokenX;
        tokens[1] = tokenY;
        deployed = new uint256[](2);
        if (amounts[0] != 0) {
            IERC20(tokenX).safeTransferFrom(vault, address(this), amounts[0]);
            deployed[0] = amounts[0];
        }
        if (amounts[1] != 0) {
            IERC20(tokenY).safeTransferFrom(vault, address(this), amounts[1]);
            deployed[1] = amounts[1];
        }
    }

    function withdrawProportional(uint256 sharesBps, address to)
        external
        returns (address[] memory tokens, uint256[] memory amounts)
    {
        if (msg.sender != vault) revert OnlyVault();
        tokens = new address[](2);
        tokens[0] = tokenX;
        tokens[1] = tokenY;
        amounts = new uint256[](2);
        (uint256 x, uint256 y) = compositionAt(sqrtP);
        amounts[0] = x * sharesBps / 10_000;
        amounts[1] = y * sharesBps / 10_000;
        // The withdrawn slice leaves the position: future payouts scale to what is LEFT.
        liquidity -= liquidity * sharesBps / 10_000;
        // A real position delivers exactly f(current price)*share; the pool side pays it.
        if (amounts[0] != 0) MockToken(tokenX).mint(to, amounts[0]);
        if (amounts[1] != 0) MockToken(tokenY).mint(to, amounts[1]);
    }

    function harvest() external view returns (address[] memory tokens, uint256[] memory amounts) {
        if (msg.sender != vault) revert OnlyVault();
        tokens = new address[](2);
        tokens[0] = tokenX;
        tokens[1] = tokenY;
        amounts = new uint256[](2);
    }

    function unwindAll(address to) external returns (address[] memory tokens, uint256[] memory amounts) {
        if (msg.sender != vault) revert OnlyVault();
        tokens = new address[](2);
        tokens[0] = tokenX;
        tokens[1] = tokenY;
        amounts = new uint256[](2);
        (uint256 x, uint256 y) = compositionAt(sqrtP);
        amounts[0] = x;
        amounts[1] = y;
        liquidity = 0;
        if (amounts[0] != 0) MockToken(tokenX).mint(to, amounts[0]);
        if (amounts[1] != 0) MockToken(tokenY).mint(to, amounts[1]);
    }
}

contract SpotReadSandwichTest is Test {
    uint256 internal constant W = 1e18;
    uint256 internal constant SA = 0.9e18; // sqrt lower = sqrt(0.81)
    uint256 internal constant SB = 1.1e18; // sqrt upper = sqrt(1.21)
    uint256 internal constant L = 1e21; // liquidity
    uint256 internal constant S0 = 1e18; // market sqrt price (=1)
    /// @dev Genesis shares K = x0 = compositionAt(S0).x = floor(L * (SB - S0) * W / (S0 * SB)) — exactly the
    ///      share scale the pre-batch-2 bootstrap minted (shares = amounts_[0] = x0), so every pinned
    ///      tolerance sees identical rounding. Re-derived deliberately: with a round K = 100e18 bob's
    ///      victim deposit floors to 66666666666666666666 shares (1 wei under 2/3 of the supply), his
    ///      redeem floors to 3999 bps instead of 4000, and that documented adapter bps-floor dust
    ///      (~0.019e18, captured by alice) lifts his measured loss to 2.0045% above eps*m/(1+m) — just
    ///      outside the 2% band. A redeem-dust artifact, not a change of the eps conclusion.
    uint256 internal constant GENESIS_K = 90_909_090_909_090_909_090;

    PoolmigoVaultUpgradeable internal vault;
    MockToken internal X; // 18dp
    MockToken internal Y; // 18dp
    SpotCompositionAdapter internal adapter;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal attacker = makeAddr("attacker");

    address[] internal basket;

    function setUp() public {
        X = new MockToken("PoC X", "X", 18);
        Y = new MockToken("PoC Y", "Y", 18);
        basket.push(address(X));
        basket.push(address(Y));

        PoolmigoVaultUpgradeable impl = new PoolmigoVaultUpgradeable();
        vault = PoolmigoVaultUpgradeable(
            address(
                new ERC1967Proxy(
                    address(impl),
                    abi.encodeCall(
                        PoolmigoVaultUpgradeable.initialize, (owner, basket, treasury, uint16(1500), GENESIS_K, 0)
                    )
                )
            )
        );

        adapter = new SpotCompositionAdapter(address(vault), address(X), address(Y), SA, SB, L, S0);

        vm.startPrank(owner);
        vault.addAdapter(IPositionAdapter(address(adapter)));
        vault.setKeeper(address(this), true);
        vm.stopPrank();

        for (uint256 i; i < 4; ++i) {
            address who = i == 0 ? alice : (i == 1 ? bob : (i == 2 ? attacker : owner));
            X.mint(who, 1_000e18);
            Y.mint(who, 1_000e18);
            vm.startPrank(who);
            X.approve(address(vault), type(uint256).max);
            Y.approve(address(vault), type(uint256).max);
            vm.stopPrank();
        }
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    function _amts(uint256 a, uint256 b) internal pure returns (uint256[] memory arr) {
        arr = new uint256[](2);
        arr[0] = a;
        arr[1] = b;
    }

    /// @dev Value in Y-units at the market price S0 (X priced (S0/W)^2 == 1 here).
    function _val(uint256 x, uint256 y) internal pure returns (uint256) {
        return x * S0 * S0 / (W * W) + y;
    }

    /// @dev eps = L*(s-t)^2/t in wei, piecewise over the range (in-range / above / below).
    function _eps(uint256 s, uint256 t) internal pure returns (uint256) {
        if (t > sb()) {
            uint256 ds = sb() - s;
            return L * ds * ds / (W * sb());
        } else if (t < sa()) {
            uint256 ds = s - sa();
            return L * ds * ds / (W * sa());
        } else {
            uint256 ds = s > t ? s - t : t - s;
            return L * ds * ds / (W * t);
        }
    }

    function sa() internal pure returns (uint256) {
        return SA;
    }

    function sb() internal pure returns (uint256) {
        return SB;
    }

    /// @dev The owner seeds genesis (owner-gated) with the exact composition of L at S0 — alice receives the
    ///      K genesis shares and is the incumbent holder — then the keeper deploys it all into the adapter.
    function _bootstrapAndDeploy() internal {
        (uint256 x0, uint256 y0) = adapter.compositionAt(S0);
        assertEq(x0, GENESIS_K, "K derived from the pre-batch scale");
        vm.prank(owner);
        vault.deposit(basket, _amts(x0, y0), GENESIS_K, alice);
        assertEq(vault.balanceOf(alice), GENESIS_K);
        vault.deployTo(IPositionAdapter(address(adapter)), _amts(x0, y0));
        assertEq(X.balanceOf(address(vault)), 0);
        assertEq(Y.balanceOf(address(vault)), 0);
    }

    /// @dev Redeem the attacker's full balance and return the received value (at S0).
    function _redeemAllAndValue() internal returns (uint256) {
        uint256 xa = X.balanceOf(attacker);
        uint256 ya = Y.balanceOf(attacker);
        uint256 sh = vault.balanceOf(attacker); // read BEFORE the prank (prank binds the next call)
        vm.prank(attacker);
        vault.redeem(sh, attacker);
        return _val(X.balanceOf(attacker) - xa, Y.balanceOf(attacker) - ya);
    }

    /// @dev Full free-manipulation sandwich: manipulate -> deposit half the basket -> restore -> redeem all.
    function _runSandwichAttack(uint256 t) internal {
        _bootstrapAndDeploy();
        uint256 supplyBefore = vault.totalSupply();
        uint256 s = adapter.sqrtP();

        adapter.setSqrtPrice(t); // FREE manipulation
        (, uint256[] memory totals) = vault.totalTokens();
        uint256[2] memory b0 = [X.balanceOf(attacker), Y.balanceOf(attacker)];

        // balanced at the manipulated composition (the optimal basket for the attacker)
        vm.prank(attacker);
        vault.deposit(basket, _amts(totals[0] / 2 + 2, totals[1] / 2 + 2), 1, attacker);
        uint256 shares = vault.balanceOf(attacker);
        uint256 paid = _val(b0[0] - X.balanceOf(attacker), b0[1] - Y.balanceOf(attacker));

        adapter.setSqrtPrice(s); // restore (free)

        uint256 got = _redeemAllAndValue();
        assertLt(got, paid, "attacker must lose: manipulated read -> overpay");
        uint256 loss = paid - got;
        uint256 expected = _eps(s, t) * shares / (supplyBefore + shares);
        assertApproxEqRel(loss, expected, 0.01e18); // 1% tolerance (bps/wei flooring)
    }

    /*//////////////////////////////////////////////////////////////
                                 TESTS
    //////////////////////////////////////////////////////////////*/

    function test_SpotSandwich_UpMove_AttackerLoses() public {
        _runSandwichAttack(S0 + S0 / 20); // +5% sqrt
    }

    function test_SpotSandwich_DownMove_AttackerLoses() public {
        _runSandwichAttack(S0 - S0 / 20); // -5% sqrt
    }

    function test_SpotSandwich_OutOfRange_AttackerLoses() public {
        _runSandwichAttack(S0 + S0 / 4); // +25% sqrt -> above range, position all-Y
    }

    /// @dev Deposit + redeem in the SAME manipulated state: exactly nothing to gain (flooring only).
    function test_SpotSandwich_InstantRoundTrip_NoGain() public {
        _bootstrapAndDeploy();
        adapter.setSqrtPrice(S0 + S0 / 20);

        (, uint256[] memory totals) = vault.totalTokens();
        uint256[2] memory b0 = [X.balanceOf(attacker), Y.balanceOf(attacker)];
        vm.prank(attacker);
        vault.deposit(basket, _amts(totals[0] / 2 + 2, totals[1] / 2 + 2), 1, attacker);
        uint256 paid = _val(b0[0] - X.balanceOf(attacker), b0[1] - Y.balanceOf(attacker));

        uint256 got = _redeemAllAndValue();
        assertLe(got, paid, "instant round trip cannot gain");
        assertLt(paid - got, 1e17, "only floor/bps dust may remain in the vault");
    }

    /// @dev Bob (stale-quote basket) deposits inside the manipulated window, then redeems after restore.
    function _victimFlow(uint256[4] memory ab, uint256 xf, uint256 yf)
        internal
        returns (uint256 bobPaid, uint256 bobShares, uint256 bobGot)
    {
        adapter.setSqrtPrice(S0 + S0 / 20); // attacker-as-holder manipulates
        vm.prank(bob);
        vault.deposit(basket, _amts(xf, yf), 1, bob);
        bobPaid = _val(ab[2] - X.balanceOf(bob), ab[3] - Y.balanceOf(bob));
        bobShares = vault.balanceOf(bob);
        ab[2] = X.balanceOf(bob);
        ab[3] = Y.balanceOf(bob);
        adapter.setSqrtPrice(S0); // restore
        vm.prank(bob);
        vault.redeem(bobShares, bob);
        bobGot = _val(X.balanceOf(bob) - ab[2], Y.balanceOf(bob) - ab[3]);
    }

    function _aliceRedeemValue(uint256[4] memory ab) internal returns (uint256) {
        uint256 sh = vault.balanceOf(alice); // read BEFORE the prank (prank binds the next call)
        vm.prank(alice);
        vault.redeem(sh, alice);
        return _val(X.balanceOf(alice) - ab[0], Y.balanceOf(alice) - ab[1]);
    }

    /// @dev Honest depositor inside a manipulated window pays eps*m/(1+m); the incumbent holder captures it.
    function test_SpotSandwich_VictimPaysEpsilon_HolderCaptures() public {
        _bootstrapAndDeploy();
        uint256 supplyBefore = vault.totalSupply();
        uint256[4] memory ab = [X.balanceOf(alice), Y.balanceOf(alice), X.balanceOf(bob), Y.balanceOf(bob)];
        (uint256 xf, uint256 yf) = adapter.compositionAt(S0); // the fair (pre-manipulation) basket

        (uint256 bobPaid, uint256 bobShares, uint256 bobGot) = _victimFlow(ab, xf, yf);
        assertLt(bobGot, bobPaid, "victim loses under the manipulated read");
        uint256 bobLoss = bobPaid - bobGot;
        assertApproxEqRel(bobLoss, _eps(S0, S0 + S0 / 20) * bobShares / (supplyBefore + bobShares), 0.02e18);

        // The epsilon is captured by the incumbent holder (conservation, within flooring dust).
        uint256 fairVal = _val(xf, yf);
        uint256 aliceGot = _aliceRedeemValue(ab);
        assertGt(aliceGot, fairVal, "holder gains");
        uint256 holderGain = aliceGot - fairVal;
        assertApproxEqRel(holderGain, bobLoss, 0.02e18);
    }
}
