// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "./GraphiteDNSRegistry.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

contract AuctionRegistrar is AccessControl, ReentrancyGuard, Pausable {
    GraphiteDNSRegistry public immutable registry;
    bytes32 public immutable TLD_NODE;

    uint256 public constant MIN_COMMIT_DURATION = 24 hours;
    uint256 public constant MAX_COMMIT_DURATION = 7 days;
    uint256 public constant MIN_REVEAL_DURATION = 24 hours;
    uint256 public constant MAX_REVEAL_DURATION = 7 days;
    uint256 public constant MIN_BID = 0.001 ether;

    enum AuctionState {
        NotStarted,
        CommitPhase,
        RevealPhase,
        Finished,
        Cancelled
    }

    struct Auction {
        uint256 startTime;
        uint256 commitEnd;
        uint256 revealEnd;
        uint256 minimumBid;
        address highestBidder;
        uint256 highestBid;
        uint256 secondHighestBid;
        AuctionState state;
        mapping(address => bytes32) commitments;
        mapping(address => uint256) deposits;
        mapping(address => bool) hasRevealed;
        uint256 totalBidders;
    }

    mapping(bytes32 => Auction) private auctions;
    mapping(string => bool) private auctionExists;

    event AuctionStarted(
        bytes32 indexed node,
        string label,
        uint256 startTime,
        uint256 commitEnd,
        uint256 revealEnd,
        uint256 minimumBid
    );
    
    event BidCommitted(
        bytes32 indexed node,
        address indexed bidder,
        bytes32 commitment
    );
    
    event BidRevealed(
        bytes32 indexed node,
        address indexed bidder,
        uint256 amount,
        bool isHighest
    );
    
    event AuctionFinalized(
        bytes32 indexed node,
        string label,
        address indexed winner,
        uint256 winningBid,
        uint256 secondBid
    );
    
    event AuctionCancelled(bytes32 indexed node, string label);
    event FundsWithdrawn(address indexed bidder, uint256 amount);

    constructor(address registryAddress) {
        registry = GraphiteDNSRegistry(registryAddress);
        TLD_NODE = registry.TLD_NODE();
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // ===== AUCTION MANAGEMENT =====

    /// @notice Start auction with validation
    function startAuction(
        string calldata label,
        uint256 commitDuration,
        uint256 revealDuration,
        uint256 minimumBid
    ) external onlyRole(DEFAULT_ADMIN_ROLE) whenNotPaused {
        require(!auctionExists[label], "Auction already exists");
        require(
            commitDuration >= MIN_COMMIT_DURATION && commitDuration <= MAX_COMMIT_DURATION,
            "Invalid commit duration"
        );
        require(
            revealDuration >= MIN_REVEAL_DURATION && revealDuration <= MAX_REVEAL_DURATION,
            "Invalid reveal duration"
        );
        require(minimumBid >= MIN_BID, "Minimum bid too low");

        bytes32 node = keccak256(abi.encodePacked(TLD_NODE, keccak256(bytes(label))));
        require(registry.isAvailable(node), "Domain not available");

        Auction storage auction = auctions[node];
        auction.startTime = block.timestamp;
        auction.commitEnd = block.timestamp + commitDuration;
        auction.revealEnd = auction.commitEnd + revealDuration;
        auction.minimumBid = minimumBid;
        auction.state = AuctionState.CommitPhase;

        auctionExists[label] = true;

        emit AuctionStarted(
            node,
            label,
            auction.startTime,
            auction.commitEnd,
            auction.revealEnd,
            minimumBid
        );
    }

    /// @notice Get auction details
    function getAuction(string calldata label)
        external
        view
        returns (
            uint256 startTime,
            uint256 commitEnd,
            uint256 revealEnd,
            uint256 minimumBid,
            address highestBidder,
            uint256 highestBid,
            uint256 secondHighestBid,
            AuctionState state,
            uint256 totalBidders
        )
    {
        bytes32 node = keccak256(abi.encodePacked(TLD_NODE, keccak256(bytes(label))));
        Auction storage auction = auctions[node];
        
        return (
            auction.startTime,
            auction.commitEnd,
            auction.revealEnd,
            auction.minimumBid,
            auction.highestBidder,
            auction.highestBid,
            auction.secondHighestBid,
            auction.state,
            auction.totalBidders
        );
    }

    // ===== BIDDING FUNCTIONS =====

    /// @notice Commit bid with validation
    function commitBid(string calldata label, bytes32 commitment) external whenNotPaused {
        bytes32 node = keccak256(abi.encodePacked(TLD_NODE, keccak256(bytes(label))));
        Auction storage auction = auctions[node];

        require(auction.state == AuctionState.CommitPhase, "Not in commit phase");
        require(block.timestamp <= auction.commitEnd, "Commit phase ended");
        require(auction.commitments[msg.sender] == bytes32(0), "Already committed");
        require(commitment != bytes32(0), "Invalid commitment");

        auction.commitments[msg.sender] = commitment;
        auction.totalBidders++;

        emit BidCommitted(node, msg.sender, commitment);
    }

    /// @notice Reveal bid with proper validation
    function revealBid(
        string calldata label,
        uint256 bid,
        bytes32 salt
    ) external payable nonReentrant whenNotPaused {
        bytes32 node = keccak256(abi.encodePacked(TLD_NODE, keccak256(bytes(label))));
        Auction storage auction = auctions[node];

        require(block.timestamp > auction.commitEnd, "Commit phase not ended");
        require(block.timestamp <= auction.revealEnd, "Reveal phase ended");
        require(!auction.hasRevealed[msg.sender], "Already revealed");
        require(msg.value == bid, "Bid amount mismatch");
        require(bid >= auction.minimumBid, "Bid below minimum");

        // Verify commitment
        bytes32 expectedCommitment = keccak256(abi.encodePacked(bid, salt, msg.sender));
        require(auction.commitments[msg.sender] == expectedCommitment, "Invalid reveal");

        auction.hasRevealed[msg.sender] = true;
        auction.deposits[msg.sender] = bid;

        bool isHighest = false;

        // Update highest and second highest bids
        if (bid > auction.highestBid) {
            // Return previous highest bidder's funds
            if (auction.highestBidder != address(0)) {
                payable(auction.highestBidder).transfer(auction.highestBid);
            }
            
            auction.secondHighestBid = auction.highestBid;
            auction.highestBid = bid;
            auction.highestBidder = msg.sender;
            isHighest = true;
        } else if (bid > auction.secondHighestBid) {
            auction.secondHighestBid = bid;
            // Return this bidder's funds as they're not winning
            payable(msg.sender).transfer(bid);
        } else {
            // Return this bidder's funds as they're not winning
            payable(msg.sender).transfer(bid);
        }

        emit BidRevealed(node, msg.sender, bid, isHighest);
        
        // Update state if reveal phase ended
        if (block.timestamp > auction.revealEnd) {
            auction.state = AuctionState.Finished;
        }
    }

    /// @notice Finalize auction with Vickrey pricing
    function finalizeAuction(
        string calldata label,
        uint64 duration,
        address resolver_
    ) external nonReentrant {
        bytes32 node = keccak256(abi.encodePacked(TLD_NODE, keccak256(bytes(label))));
        Auction storage auction = auctions[node];

        require(block.timestamp > auction.revealEnd, "Auction not ended");
        require(auction.state == AuctionState.Finished, "Auction not in finished state");
        require(auction.highestBidder != address(0), "No valid bids");
        
        // Only winner can finalize
        require(msg.sender == auction.highestBidder, "Not the winner");

        auction.state = AuctionState.Finished;

        // Vickrey auction: winner pays second-highest bid
        uint256 finalPrice = auction.secondHighestBid > 0 ? auction.secondHighestBid : auction.minimumBid;
        
        // Refund difference to winner if they overpaid
        if (auction.highestBid > finalPrice) {
            payable(auction.highestBidder).transfer(auction.highestBid - finalPrice);
        }

        // Register domain with final price
        registry.register{value: finalPrice}(
            label,
            auction.highestBidder,
            duration,
            resolver_,
            TLD_NODE
        );

        emit AuctionFinalized(
            node,
            label,
            auction.highestBidder,
            finalPrice,
            auction.secondHighestBid
        );
    }

    // ===== EMERGENCY FUNCTIONS =====

    /// @notice Cancel auction and refund all bidders
    function cancelAuction(string calldata label) external onlyRole(DEFAULT_ADMIN_ROLE) {
        bytes32 node = keccak256(abi.encodePacked(TLD_NODE, keccak256(bytes(label))));
        Auction storage auction = auctions[node];

        require(auction.state != AuctionState.NotStarted, "Auction doesn't exist");
        require(auction.state != AuctionState.Finished, "Auction already finished");

        auction.state = AuctionState.Cancelled;

        // Refund highest bidder if exists
        if (auction.highestBidder != address(0) && auction.highestBid > 0) {
            payable(auction.highestBidder).transfer(auction.highestBid);
        }

        auctionExists[label] = false;
        emit AuctionCancelled(node, label);
    }

    /// @notice Emergency withdrawal for stuck funds
    function emergencyWithdraw() external onlyRole(DEFAULT_ADMIN_ROLE) {
        payable(msg.sender).transfer(address(this).balance);
    }

    // ===== VIEW FUNCTIONS =====

    /// @notice Check if user has committed to an auction
    function hasCommitted(string calldata label, address bidder) external view returns (bool) {
        bytes32 node = keccak256(abi.encodePacked(TLD_NODE, keccak256(bytes(label))));
        return auctions[node].commitments[bidder] != bytes32(0);
    }

    /// @notice Check if user has revealed their bid
    function hasRevealed(string calldata label, address bidder) external view returns (bool) {
        bytes32 node = keccak256(abi.encodePacked(TLD_NODE, keccak256(bytes(label))));
        return auctions[node].hasRevealed[bidder];
    }

    /// @notice Generate commitment hash for frontend
    function generateCommitment(
        uint256 bid,
        bytes32 salt,
        address bidder
    ) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(bid, salt, bidder));
    }

    function supportsInterface(
        bytes4 interfaceId
    ) public view override(AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}