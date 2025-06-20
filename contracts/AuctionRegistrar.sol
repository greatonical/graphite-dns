// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./GraphiteDNSRegistry.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

contract AuctionRegistrar is GraphiteDNSRegistry {
    using ECDSA for bytes32;

    constructor(address resolverForTLD)
        GraphiteDNSRegistry(resolverForTLD)
    {}

    struct Auction {
        uint256 commitEnd;
        uint256 revealEnd;
        address highestBidder;
        uint256 highestBid;
        bool finalized;
        mapping(address => bytes32) commitments;
        mapping(address => uint256) deposits;
    }

    mapping(bytes32 => Auction) private _auctions;

    function startAuction(
        string calldata label,
        uint256 commitDuration,
        uint256 revealDuration
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        bytes32 node = _makeNode(TLD_NODE, label);
        Auction storage a = _auctions[node];
        require(a.commitEnd == 0, "Exists");
        a.commitEnd = block.timestamp + commitDuration;
        a.revealEnd = a.commitEnd + revealDuration;
    }

    function commitBid(string calldata label, bytes32 bidHash) external {
        bytes32 node = _makeNode(TLD_NODE, label);
        Auction storage a = _auctions[node];
        require(block.timestamp <= a.commitEnd, "Commit closed");
        require(a.commitments[msg.sender] == bytes32(0), "Committed");
        a.commitments[msg.sender] = bidHash;
    }

    function revealBid(
        string calldata label,
        uint256 bid,
        bytes32 salt
    ) external payable {
        bytes32 node = _makeNode(TLD_NODE, label);
        Auction storage a = _auctions[node];
        require(
            block.timestamp > a.commitEnd && block.timestamp <= a.revealEnd,
            "No reveal"
        );
        require(
            a.commitments[msg.sender] == keccak256(abi.encodePacked(bid, salt)),
            "Bad reveal"
        );
        require(msg.value == bid, "Wrong deposit");
        a.deposits[msg.sender] = bid;

        if (bid > a.highestBid) {
            if (a.highestBidder != address(0)) {
                payable(a.highestBidder).transfer(a.highestBid);
            }
            a.highestBid = bid;
            a.highestBidder = msg.sender;
        } else {
            payable(msg.sender).transfer(bid);
        }
    }

    function finalizeAuction(
        string calldata label,
        address owner,
        uint64 duration,
        address resolver,
        bytes32 parent
    ) external nonReentrant {
        bytes32 node = _makeNode(parent, label);
        Auction storage a = _auctions[node];
        require(block.timestamp > a.revealEnd, "Open");
        require(!a.finalized, "Done");
        require(msg.sender == a.highestBidder, "Not winner");
        a.finalized = true;

        _registerDomain(node, label, owner, duration, resolver, parent);
    }
}
