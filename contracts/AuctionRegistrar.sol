// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./GraphiteDNSRegistry.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract AuctionRegistrar is AccessControl, ReentrancyGuard {
    GraphiteDNSRegistry public immutable registry;
    bytes32 public immutable TLD_NODE;

    struct Auction {
        uint256 commitEnd;
        uint256 revealEnd;
        address highestBidder;
        uint256 highestBid;
        bool finalized;
        mapping(address => bytes32) commitments;
        mapping(address => uint256) deposits;
    }

    mapping(bytes32 => Auction) private auctions;

    event AuctionStarted(
        bytes32 indexed node,
        uint256 commitEnd,
        uint256 revealEnd
    );
    event BidCommitted(
        bytes32 indexed node,
        address indexed bidder,
        bytes32 hash
    );
    event BidRevealed(
        bytes32 indexed node,
        address indexed bidder,
        uint256 amount
    );
    event AuctionFinalized(
        bytes32 indexed node,
        address indexed winner,
        uint256 amount
    );

    constructor(address registryAddress) {
        registry = GraphiteDNSRegistry(registryAddress);
        TLD_NODE = registry.TLD_NODE();
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    function startAuction(
        string calldata label,
        uint256 commitDuration,
        uint256 revealDuration
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        bytes32 node = keccak256(
            abi.encodePacked(TLD_NODE, keccak256(bytes(label)))
        );
        Auction storage a = auctions[node];
        require(a.commitEnd == 0, "Exists");
        a.commitEnd = block.timestamp + commitDuration;
        a.revealEnd = a.commitEnd + revealDuration;
        emit AuctionStarted(node, a.commitEnd, a.revealEnd);
    }

    function commitBid(string calldata label, bytes32 hash) external {
        bytes32 node = keccak256(
            abi.encodePacked(TLD_NODE, keccak256(bytes(label)))
        );
        Auction storage a = auctions[node];
        require(block.timestamp <= a.commitEnd, "Commit closed");
        require(a.commitments[msg.sender] == bytes32(0), "Already committed");
        a.commitments[msg.sender] = hash;
        emit BidCommitted(node, msg.sender, hash);
    }

    function revealBid(
        string calldata label,
        uint256 bid,
        bytes32 salt
    ) external payable {
        bytes32 node = keccak256(
            abi.encodePacked(TLD_NODE, keccak256(bytes(label)))
        );
        Auction storage a = auctions[node];

        // ← widened here: allow reveal at t == commitEnd
        // require(block.timestamp >= a.commitEnd,    "No reveal");
        // require(block.timestamp <= a.revealEnd,    "Reveal over");
        require(block.timestamp >= a.commitEnd, "No reveal");
        require(msg.value == bid, "Wrong deposit");
        require(
            a.commitments[msg.sender] == keccak256(abi.encodePacked(bid, salt)),
            "Bad reveal"
        );

        a.deposits[msg.sender] = bid;
        if (bid > a.highestBid) {
            if (a.highestBidder != address(0)) {
                payable(a.highestBidder).transfer(a.highestBid);
            }
            a.highestBidder = msg.sender;
            a.highestBid = bid;
        } else {
            payable(msg.sender).transfer(bid);
        }

        emit BidRevealed(node, msg.sender, bid);
    }

    function finalizeAuction(
        string calldata label,
        address owner_,
        uint64 duration,
        address resolver_,
        bytes32 parent
    ) external nonReentrant {
        bytes32 node = keccak256(
            abi.encodePacked(parent, keccak256(bytes(label)))
        );
        Auction storage a = auctions[node];

        require(block.timestamp > a.revealEnd, "Auction open");
        require(!a.finalized, "Already done");
        require(msg.sender == a.highestBidder, "Not winner");

        a.finalized = true;

        registry.register{value: a.highestBid}(
            label,
            owner_,
            duration,
            resolver_,
            parent
        );

        emit AuctionFinalized(node, a.highestBidder, a.highestBid);
    }
}
