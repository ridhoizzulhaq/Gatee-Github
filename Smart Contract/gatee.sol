// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 value) external returns (bool);
}

interface IERC1155Mint {
    function mintTo(address to, uint256 id, uint256 amount, bytes calldata data) external;
}

interface IMessageTransmitterV2 {
    function receiveMessage(bytes calldata message, bytes calldata attestation) external returns (bool);
}

abstract contract Ownable {
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);
    address public owner;
    modifier onlyOwner() { require(msg.sender == owner, "only owner"); _; }
    constructor() { owner = msg.sender; emit OwnershipTransferred(address(0), msg.sender); }
    function transferOwnership(address newOwner) external onlyOwner { require(newOwner!=address(0),"bad"); emit OwnershipTransferred(owner,newOwner); owner=newOwner; }
}

abstract contract ReentrancyGuard {
    uint256 private locked = 1;
    modifier nonReentrant() {
        require(locked == 1, "reentrancy");
        locked = 2;
        _;
        locked = 1;
    }
}

contract GateeHookSplitPriced is Ownable, ReentrancyGuard {
    IERC20 public immutable USDC;                      // Base Sepolia USDC
    IMessageTransmitterV2 public immutable messageTransmitterV2; // Base Sepolia MTv2
    IERC1155Mint public immutable voucher1155;

    uint16 public constant BPS_DENOM = 10_000;
    address[] public recipients;
    uint16[]  public bps; // Σ = 10000

    // tokenId => price (6 decimals, USDC)
    mapping(uint256 => uint256) public price6;

    event SplitTransfer(address indexed to, uint256 amount);
    event PriceSet(uint256 indexed tokenId, uint256 price6);
    event PaidAndMinted(address indexed buyer, uint256 indexed tokenId, uint256 qty, uint256 totalForwarded, string memo);

    constructor(
        address usdc_,
        address transmitter_,
        address voucher1155_,
        address[] memory recipients_,
        uint16[]  memory bps_,
        uint256[] memory priceIds,
        uint256[] memory priceVals6
    ) {
        require(usdc_ != address(0) && transmitter_ != address(0) && voucher1155_ != address(0), "zero addr");
        require(recipients_.length == bps_.length && recipients_.length > 0, "bad splits");
        uint256 sum;
        for (uint256 i=0; i<bps_.length; i++) {
            require(recipients_[i] != address(0), "zero recipient");
            sum += bps_[i];
        }
        require(sum == BPS_DENOM, "bps != 10000");

        USDC = IERC20(usdc_);
        messageTransmitterV2 = IMessageTransmitterV2(transmitter_);
        voucher1155 = IERC1155Mint(voucher1155_);

        recipients = recipients_;
        bps = bps_;

        require(priceIds.length == priceVals6.length, "bad prices");
        for (uint256 i=0; i<priceIds.length; i++) {
            require(priceVals6[i] > 0, "zero price");
            price6[priceIds[i]] = priceVals6[i];
            emit PriceSet(priceIds[i], priceVals6[i]);
        }
    }

    function setPrice(uint256 tokenId, uint256 p6) external onlyOwner {
        require(p6 > 0, "zero price");
        price6[tokenId] = p6;
        emit PriceSet(tokenId, p6);
    }

    function setPrices(uint256[] calldata ids, uint256[] calldata p6s) external onlyOwner {
        require(ids.length == p6s.length && ids.length>0, "bad");
        for (uint256 i=0; i<ids.length; i++) {
            require(p6s[i] > 0, "zero");
            price6[ids[i]] = p6s[i];
            emit PriceSet(ids[i], p6s[i]);
        }
    }

    function getSplits() external view returns (address[] memory, uint16[] memory) {
        return (recipients, bps);
    }

    function relayAndProcess(
        bytes calldata message,
        bytes calldata attestation,
        address buyer,
        uint256 tokenId,
        uint256 qty,
        string calldata memo
    ) external nonReentrant returns (bool) {
        require(buyer != address(0), "bad buyer");
        require(qty > 0, "qty=0");
        uint256 unit = price6[tokenId];
        require(unit > 0, "price not set");
        uint256 expected = unit * qty;

        uint256 balBefore = USDC.balanceOf(address(this));
        bool ok = messageTransmitterV2.receiveMessage(message, attestation); 

        uint256 balAfter = USDC.balanceOf(address(this));
        uint256 delta = balAfter - balBefore;
        require(delta == expected, "amount mismatch");

        uint256 forwardedSum;
        for (uint256 i=0; i<recipients.length; i++) {
            uint256 share = (delta * bps[i]) / BPS_DENOM;
            forwardedSum += share;
            _safeTransfer(address(USDC), recipients[i], share);
            emit SplitTransfer(recipients[i], share);
        }
        if (forwardedSum < delta) {
            uint256 dust = delta - forwardedSum;
            _safeTransfer(address(USDC), recipients[0], dust);
            forwardedSum += dust;
            emit SplitTransfer(recipients[0], dust);
        }
        require(forwardedSum == delta, "split error");

        voucher1155.mintTo(buyer, tokenId, qty, "");
        emit PaidAndMinted(buyer, tokenId, qty, delta, memo);
        return true;
    }

    // Plan-B: kalau ada pihak lain sudah relay duluan (USDC sdh masuk), selesaikan prosesnya.
    function processAfterMint(address buyer, uint256 tokenId, uint256 qty, string calldata memo)
        external nonReentrant returns (bool)
    {
        require(buyer != address(0) && qty>0, "bad args");
        uint256 expected = price6[tokenId] * qty;
        require(expected > 0, "price not set");
        uint256 bal = USDC.balanceOf(address(this));
        require(bal >= expected, "insufficient minted");

        uint256 forwardedSum;
        for (uint256 i=0; i<recipients.length; i++) {
            uint256 share = (expected * bps[i]) / BPS_DENOM;
            forwardedSum += share;
            _safeTransfer(address(USDC), recipients[i], share);
            emit SplitTransfer(recipients[i], share);
        }
        if (forwardedSum < expected) {
            uint256 dust = expected - forwardedSum;
            _safeTransfer(address(USDC), recipients[0], dust);
            forwardedSum += dust;
            emit SplitTransfer(recipients[0], dust);
        }
        require(forwardedSum == expected, "split error");

        voucher1155.mintTo(buyer, tokenId, qty, "");
        emit PaidAndMinted(buyer, tokenId, qty, expected, memo);
        return true;
    }

    function _safeTransfer(address token, address to, uint256 value) internal {
        (bool success, bytes memory data) = token.call(abi.encodeWithSelector(IERC20.transfer.selector, to, value));
        require(success && (data.length == 0 || abi.decode(data, (bool))), "USDC transfer failed");
    }
}