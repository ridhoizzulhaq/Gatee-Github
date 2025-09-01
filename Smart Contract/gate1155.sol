// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract gate1155 is ERC1155, Ownable {
    address public minter;

   
    constructor(string memory baseURI) ERC1155(baseURI) Ownable(msg.sender) {}

    event MinterUpdated(address indexed newMinter);

    function setMinter(address m) external onlyOwner {
        require(m != address(0), "minter=0");
        minter = m;
        emit MinterUpdated(m);
    }

    modifier onlyMinterOrOwner() {
        require(msg.sender == minter || msg.sender == owner(), "not minter");
        _;
    }

   
    function mintTo(
        address to,
        uint256 id,
        uint256 amount,
        bytes calldata data
    )
        external
        onlyMinterOrOwner
    {
        _mint(to, id, amount, data);
    }
}