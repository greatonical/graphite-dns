// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./interfaces/IGraphiteDNSRegistry.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

contract AuctionRegistrar is AccessControl, ReentrancyGuard, Pausable {
    IGraphiteDNSRegistry public immutable registry;
    bytes32 public immutable TLD_NODE;

    uint256 public constant MIN_COMMIT_DURATION = 1 hours;
    uint256 public constant MAX_COMMIT_DURATION = 7 days;
    uint256 public constant MIN_REVEAL_DURATION = 1 hours;
    uint256 public constant MAX_REVEAL_DURATION = 3 days;
    uint256 public constant ANTI_SNIPE_DURATION = 10 minutes;

    struct Auction {
        uint256 commitEnd;
        uint256 revealEnd;
        address highestBidder;
        uint256 highestBid;
        uint256 secondHighestBid;
        bool finalized;
        bool extended;
        mapping(address => bytes32) commitments;
        mapping(address => uint256) deposits;
        mapping(address => bool) hasRevealed;
    }

    mapping(bytes32 => Auction) private auctions;
    mapping(address => uint256) private pendingReturns;

    event AuctionStarted(
        bytes32 indexed node,
        string label,
        uint256 commitEnd,
        uint256 revealEnd
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
    event AuctionExtended(
        bytes32 indexed node,
        uint256 newRevealEnd
    );
    event AuctionFinalized(
        bytes32 indexed node,
        address indexed winner,
        uint256 winningBid,
        uint256 paidAmount
    );
    event FundsWithdrawn(
        address indexed bidder,
        uint256 amount
    );

    constructor(address registryAddress) {
        registry = IGraphiteDNSRegistry(registryAddress);
        TLD_NODE = registry.TLD_NODE();
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // ============ Auction Management ============

    function startAuction(
        string calldata label,
        uint256 commitDuration,
        uint256 revealDuration
    ) external onlyRole(DEFAULT_ADMIN_ROLE) whenNotPaused {
        require(
            commitDuration >= MIN_COMMIT_DURATION && commitDuration <= MAX_COMMIT_DURATION,
            "Invalid commit duration"
        );
        require(
            revealDuration >= MIN_REVEAL_DURATION && revealDuration <= MAX_REVEAL_DURATION,
            "Invalid reveal duration"
        );

        bytes32 node = keccak256(abi.encodePacked(TLD_NODE, keccak256(bytes(label))));
        require(registry.isAvailable(node), "Domain not available");

        Auction storage auction = auctions[node];
        require(auction.commitEnd == 0, "Auction already exists");

        auction.commitEnd = block.timestamp + commitDuration;
        auction.revealEnd = auction.commitEnd + revealDuration;

        emit AuctionStarted(node, label, auction.commitEnd, auction.revealEnd);
    }

    // ============ Bidding Functions ============

    function commitBid(string calldata label, bytes32 commitment) 
        external 
        whenNotPaused 
    {
        bytes32 node = keccak256(abi.encodePacked(TLD_NODE, keccak256(bytes(label))));
        Auction storage auction = auctions[node];
        
        require(auction.commitEnd > 0, "Auction does not exist");
        require(block.timestamp < auction.commitEnd, "Commit phase ended");
        require(auction.commitments[msg.sender] == bytes32(0), "Already committed");

        auction.commitments[msg.sender] = commitment;
        emit BidCommitted(node, msg.sender, commitment);
    }

    function revealBid(
        string calldata label,
        uint256 bid,
        bytes32 salt
    ) external payable whenNotPaused nonReentrant {
        bytes32 node = keccak256(abi.encodePacked(TLD_NODE, keccak256(bytes(label))));
        Auction storage auction = auctions[node];

        require(block.timestamp >= auction.commitEnd, "Commit phase not ended");
        require(block.timestamp < auction.revealEnd, "Reveal phase ended");
        require(!auction.hasRevealed[msg.sender], "Already revealed");

        // Verify commitment
        bytes32 commitment = keccak256(abi.encodePacked(msg.sender, bid, salt));
        require(auction.commitments[msg.sender] == commitment, "Invalid commitment");

        auction.hasRevealed[msg.sender] = true;
        auction.deposits[msg.sender] = msg.value;

        require(msg.value >= bid, "Insufficient deposit");

        bool isHighest = false;
        bool extended = false;

        // Check if this is a new highest bid
        if (bid > auction.highestBid) {
            // Update second highest
            auction.secondHighestBid = auction.highestBid;
            
            // Set new highest
            auction.highestBid = bid;
            auction.highestBidder = msg.sender;
            isHighest = true;

            // Anti-sniping: extend auction if bid comes in last 10 minutes
            if (block.timestamp > auction.revealEnd - ANTI_SNIPE_DURATION && !auction.extended) {
                auction.revealEnd = block.timestamp + ANTI_SNIPE_DURATION;
                auction.extended = true;
                extended = true;
                emit AuctionExtended(node, auction.revealEnd);
            }
        } else if (bid > auction.secondHighestBid) {
            auction.secondHighestBid = bid;
        }

        emit BidRevealed(node, msg.sender, bid, isHighest);

        if (extended) {
            emit AuctionExtended(node, auction.revealEnd);
        }
    }

    // ============ Finalization ============

    function finalizeAuction(
        string calldata label,
        address resolver_,
        uint64 duration
    ) external whenNotPaused nonReentrant {
        bytes32 node = keccak256(abi.encodePacked(TLD_NODE, keccak256(bytes(label))));
        Auction storage auction = auctions[node];

        require(auction.commitEnd > 0, "Auction does not exist");
        require(block.timestamp >= auction.revealEnd, "Auction not ended");
        require(!auction.finalized, "Already finalized");
        require(auction.highestBidder != address(0), "No valid bids");

        auction.finalized = true;

        // In Vickrey auction, winner pays second-highest price
        uint256 paidAmount = auction.secondHighestBid > 0 ? auction.secondHighestBid : auction.highestBid;
        
        // Register domain
        registry.register{value: paidAmount}(
            label,
            auction.highestBidder,
            duration,
            resolver_,
            TLD_NODE
        );

        // Handle refunds
        uint256 winnerDeposit = auction.deposits[auction.highestBidder];
        if (winnerDeposit > paidAmount) {
            pendingReturns[auction.highestBidder] += winnerDeposit - paidAmount;
        }

        emit AuctionFinalized(node, auction.highestBidder, auction.highestBid, paidAmount);
    }

    // ============ Withdrawal Functions ============

    function withdraw() external nonReentrant {
        uint256 amount = pendingReturns[msg.sender];
        require(amount > 0, "No funds to withdraw");

        pendingReturns[msg.sender] = 0;
        payable(msg.sender).transfer(amount);

        emit FundsWithdrawn(msg.sender, amount);
    }

    function withdrawForBidder(bytes32 node, address bidder) 
        external 
        nonReentrant 
    {
        Auction storage auction = auctions[node];
        require(auction.finalized, "Auction not finalized");
        require(bidder != auction.highestBidder, "Winner cannot use this function");

        uint256 deposit = auction.deposits[bidder];
        require(deposit > 0, "No deposit to withdraw");

        auction.deposits[bidder] = 0;
        pendingReturns[bidder] += deposit;
    }

    // ============ View Functions ============

    function getAuctionInfo(bytes32 node) 
        external 
        view 
        returns (
            uint256 commitEnd,
            uint256 revealEnd,
            address highestBidder,
            uint256 highestBid,
            uint256 secondHighestBid,
            bool finalized
        ) 
    {
        Auction storage auction = auctions[node];
        return (
            auction.commitEnd,
            auction.revealEnd,
            auction.highestBidder,
            auction.highestBid,
            auction.secondHighestBid,
            auction.finalized
        );
    }

    function getCommitment(bytes32 node, address bidder) 
        external 
        view 
        returns (bytes32) 
    {
        return auctions[node].commitments[bidder];
    }

    function hasRevealed(bytes32 node, address bidder) 
        external 
        view 
        returns (bool) 
    {
        return auctions[node].hasRevealed[bidder];
    }

    function getPendingReturns(address bidder) 
        external 
        view 
        returns (uint256) 
    {
        return pendingReturns[bidder];
    }

    function getDeposit(bytes32 node, address bidder) 
        external 
        view 
        returns (uint256) 
    {
        return auctions[node].deposits[bidder];
    }

    // ============ Emergency Functions ============

    function emergencyWithdraw() external onlyRole(DEFAULT_ADMIN_ROLE) {
        payable(msg.sender).transfer(address(this).balance);
    }

    // ============ Interface Support ============

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(AccessControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}