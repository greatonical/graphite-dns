import { expect } from "chai";
import { ethers } from "hardhat";
import type { GraphiteDNSRegistry, GraphiteResolver, AuctionRegistrar } from "../typechain";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("AuctionRegistrar - Fixed Version", function () {
  let registry: GraphiteDNSRegistry;
  let resolver: GraphiteResolver;
  let auction: AuctionRegistrar;
  let owner: SignerWithAddress;
  let bidder1: SignerWithAddress;
  let bidder2: SignerWithAddress;
  let bidder3: SignerWithAddress;

  const oneDay = 24 * 60 * 60;
  const oneYear = 365 * oneDay;
  const minBid = ethers.parseEther("0.001");

  beforeEach(async function () {
    [owner, bidder1, bidder2, bidder3] = await ethers.getSigners();

    // Deploy resolver
    const ResolverFactory = await ethers.getContractFactory("GraphiteResolver");
    const tempResolver = await ResolverFactory.deploy(ethers.ZeroAddress);
    
    // Deploy registry
    const RegistryFactory = await ethers.getContractFactory("GraphiteDNSRegistry");
    registry = await RegistryFactory.deploy(await tempResolver.getAddress());
    
    // Deploy final resolver
    resolver = await ResolverFactory.deploy(await registry.getAddress());
    
    // Deploy auction registrar
    const AuctionFactory = await ethers.getContractFactory("AuctionRegistrar");
    auction = await AuctionFactory.deploy(await registry.getAddress());

    // Grant REGISTRAR_ROLE to auction contract
    const registrarRole = await registry.REGISTRAR_ROLE();
    await registry.grantRole(registrarRole, await auction.getAddress());
  });

  describe("Auction Creation", function () {
    it("Should create auction with valid parameters", async function () {
      await expect(
        auction.startAuction("premium", 2 * oneDay, oneDay, minBid)
      ).to.emit(auction, "AuctionStarted");

      const auctionData = await auction.getAuction("premium");
      expect(auctionData.minimumBid).to.equal(minBid);
      expect(auctionData.state).to.equal(1); // CommitPhase
    });

    it("Should reject invalid commit duration", async function () {
      await expect(
        auction.startAuction("test", 1000, oneDay, minBid) // Too short
      ).to.be.revertedWith("Invalid commit duration");

      await expect(
        auction.startAuction("test", 10 * oneDay, oneDay, minBid) // Too long
      ).to.be.revertedWith("Invalid commit duration");
    });

    it("Should reject invalid reveal duration", async function () {
      await expect(
        auction.startAuction("test", 2 * oneDay, 1000, minBid) // Too short
      ).to.be.revertedWith("Invalid reveal duration");

      await expect(
        auction.startAuction("test", 2 * oneDay, 10 * oneDay, minBid) // Too long
      ).to.be.revertedWith("Invalid reveal duration");
    });

    it("Should reject minimum bid below threshold", async function () {
      await expect(
        auction.startAuction("test", 2 * oneDay, oneDay, ethers.parseEther("0.0005"))
      ).to.be.revertedWith("Minimum bid too low");
    });

    it("Should reject auction for unavailable domain", async function () {
      // Register domain first
      const price = await registry["priceOf(string,uint64)"]("taken", oneYear);
      await registry.connect(bidder1).buyFixedPrice(
        "taken",
        await resolver.getAddress(),
        oneYear,
        { value: price }
      );

      // Try to auction it
      await expect(
        auction.startAuction("taken", 2 * oneDay, oneDay, minBid)
      ).to.be.revertedWith("Domain not available");
    });

    it("Should prevent duplicate auctions", async function () {
      await auction.startAuction("unique", 2 * oneDay, oneDay, minBid);
      
      await expect(
        auction.startAuction("unique", 2 * oneDay, oneDay, minBid)
      ).to.be.revertedWith("Auction already exists");
    });
  });

  describe("Bid Commitment", function () {
    beforeEach(async function () {
      await auction.startAuction("test", 2 * oneDay, oneDay, minBid);
    });

    it("Should allow valid bid commitment", async function () {
      const commitment = await auction.generateCommitment(
        ethers.parseEther("1.0"),
        ethers.keccak256(ethers.toUtf8Bytes("salt1")),
        bidder1.address
      );

      await expect(
        auction.connect(bidder1).commitBid("test", commitment)
      ).to.emit(auction, "BidCommitted");

      expect(await auction.hasCommitted("test", bidder1.address)).to.be.true;
    });

    it("Should reject commitment with zero hash", async function () {
      await expect(
        auction.connect(bidder1).commitBid("test", ethers.ZeroHash)
      ).to.be.revertedWith("Invalid commitment");
    });

    it("Should reject double commitment", async function () {
      const commitment = await auction.generateCommitment(
        ethers.parseEther("1.0"),
        ethers.keccak256(ethers.toUtf8Bytes("salt1")),
        bidder1.address
      );

      await auction.connect(bidder1).commitBid("test", commitment);
      
      await expect(
        auction.connect(bidder1).commitBid("test", commitment)
      ).to.be.revertedWith("Already committed");
    });

    it("Should reject commitment after commit phase", async function () {
      // Fast forward past commit phase
      await time.increase(3 * oneDay);

      const commitment = await auction.generateCommitment(
        ethers.parseEther("1.0"),
        ethers.keccak256(ethers.toUtf8Bytes("salt1")),
        bidder1.address
      );

      await expect(
        auction.connect(bidder1).commitBid("test", commitment)
      ).to.be.revertedWith("Commit phase ended");
    });

    it("Should track total bidders", async function () {
      const commitment1 = await auction.generateCommitment(
        ethers.parseEther("1.0"),
        ethers.keccak256(ethers.toUtf8Bytes("salt1")),
        bidder1.address
      );
      const commitment2 = await auction.generateCommitment(
        ethers.parseEther("2.0"),
        ethers.keccak256(ethers.toUtf8Bytes("salt2")),
        bidder2.address
      );

      await auction.connect(bidder1).commitBid("test", commitment1);
      await auction.connect(bidder2).commitBid("test", commitment2);

      const auctionData = await auction.getAuction("test");
      expect(auctionData.totalBidders).to.equal(2);
    });
  });

  describe("Bid Revelation", function () {
    const bid1 = ethers.parseEther("1.5");
    const bid2 = ethers.parseEther("2.0");
    const bid3 = ethers.parseEther("1.2");
    const salt1 = ethers.keccak256(ethers.toUtf8Bytes("salt1"));
    const salt2 = ethers.keccak256(ethers.toUtf8Bytes("salt2"));
    const salt3 = ethers.keccak256(ethers.toUtf8Bytes("salt3"));

    beforeEach(async function () {
      await auction.startAuction("test", 2 * oneDay, oneDay, minBid);

      // Commit bids
      const commitment1 = await auction.generateCommitment(bid1, salt1, bidder1.address);
      const commitment2 = await auction.generateCommitment(bid2, salt2, bidder2.address);
      const commitment3 = await auction.generateCommitment(bid3, salt3, bidder3.address);

      await auction.connect(bidder1).commitBid("test", commitment1);
      await auction.connect(bidder2).commitBid("test", commitment2);
      await auction.connect(bidder3).commitBid("test", commitment3);

      // Move to reveal phase
      await time.increase(2 * oneDay + 1);
    });

    it("Should allow valid bid revelation", async function () {
      await expect(
        auction.connect(bidder1).revealBid("test", bid1, salt1, { value: bid1 })
      ).to.emit(auction, "BidRevealed")
       .withArgs(ethers.keccak256(ethers.concat([
         await registry.TLD_NODE(),
         ethers.keccak256(ethers.toUtf8Bytes("test"))
       ])), bidder1.address, bid1, true);

      expect(await auction.hasRevealed("test", bidder1.address)).to.be.true;
    });

    it("Should properly handle highest and second highest bids", async function () {
      const bidder2BalanceBefore = await ethers.provider.getBalance(bidder2.address);
      
      // Reveal highest bid first
      await auction.connect(bidder2).revealBid("test", bid2, salt2, { value: bid2 });
      
      // Reveal lower bid - should get refunded immediately
      const tx = await auction.connect(bidder1).revealBid("test", bid1, salt1, { value: bid1 });
      const receipt = await tx.wait();
      const gasUsed = receipt!.gasUsed * receipt!.gasPrice;
      
      const bidder1BalanceAfter = await ethers.provider.getBalance(bidder1.address);
      // bidder1 should get their money back (minus gas)
      
      // Check auction state
      const auctionData = await auction.getAuction("test");
      expect(auctionData.highestBidder).to.equal(bidder2.address);
      expect(auctionData.highestBid).to.equal(bid2);
      expect(auctionData.secondHighestBid).to.equal(bid1);
    });

    it("Should handle bid revelation in different orders", async function () {
      // Reveal in ascending order
      await auction.connect(bidder3).revealBid("test", bid3, salt3, { value: bid3 });
      await auction.connect(bidder1).revealBid("test", bid1, salt1, { value: bid1 });
      await auction.connect(bidder2).revealBid("test", bid2, salt2, { value: bid2 });

      const auctionData = await auction.getAuction("test");
      expect(auctionData.highestBidder).to.equal(bidder2.address);
      expect(auctionData.highestBid).to.equal(bid2);
      expect(auctionData.secondHighestBid).to.equal(bid1);
    });

    it("Should reject revelation with wrong bid amount", async function () {
      await expect(
        auction.connect(bidder1).revealBid("test", bid1, salt1, { value: bid1 - 1n })
      ).to.be.revertedWith("Bid amount mismatch");
    });

    it("Should reject revelation with wrong salt", async function () {
      const wrongSalt = ethers.keccak256(ethers.toUtf8Bytes("wrongsalt"));
      
      await expect(
        auction.connect(bidder1).revealBid("test", bid1, wrongSalt, { value: bid1 })
      ).to.be.revertedWith("Invalid reveal");
    });

    it("Should reject bid below minimum", async function () {
      const lowBid = ethers.parseEther("0.0005");
      const lowSalt = ethers.keccak256(ethers.toUtf8Bytes("lowsalt"));
      
      // First commit the low bid
      await auction.startAuction("lowtest", 2 * oneDay, oneDay, minBid);
      const lowCommitment = await auction.generateCommitment(lowBid, lowSalt, bidder1.address);
      await auction.connect(bidder1).commitBid("lowtest", lowCommitment);
      await time.increase(2 * oneDay + 1);

      await expect(
        auction.connect(bidder1).revealBid("lowtest", lowBid, lowSalt, { value: lowBid })
      ).to.be.revertedWith("Bid below minimum");
    });

    it("Should prevent double revelation", async function () {
      await auction.connect(bidder1).revealBid("test", bid1, salt1, { value: bid1 });
      
      await expect(
        auction.connect(bidder1).revealBid("test", bid1, salt1, { value: bid1 })
      ).to.be.revertedWith("Already revealed");
    });

    it("Should reject revelation outside reveal phase", async function () {
      // Before reveal phase
      await auction.startAuction("early", 2 * oneDay, oneDay, minBid);
      const commitment = await auction.generateCommitment(bid1, salt1, bidder1.address);
      await auction.connect(bidder1).commitBid("early", commitment);

      await expect(
        auction.connect(bidder1).revealBid("early", bid1, salt1, { value: bid1 })
      ).to.be.revertedWith("Commit phase not ended");

      // After reveal phase
      await time.increase(4 * oneDay);
      
      await expect(
        auction.connect(bidder1).revealBid("test", bid1, salt1, { value: bid1 })
      ).to.be.revertedWith("Reveal phase ended");
    });
  });

  describe("Auction Finalization", function () {
    const bid1 = ethers.parseEther("1.5");
    const bid2 = ethers.parseEther("2.0");
    const salt1 = ethers.keccak256(ethers.toUtf8Bytes("salt1"));
    const salt2 = ethers.keccak256(ethers.toUtf8Bytes("salt2"));

    beforeEach(async function () {
      await auction.startAuction("final", 2 * oneDay, oneDay, minBid);

      // Commit and reveal bids
      const commitment1 = await auction.generateCommitment(bid1, salt1, bidder1.address);
      const commitment2 = await auction.generateCommitment(bid2, salt2, bidder2.address);

      await auction.connect(bidder1).commitBid("final", commitment1);
      await auction.connect(bidder2).commitBid("final", commitment2);

      await time.increase(2 * oneDay + 1);

      await auction.connect(bidder1).revealBid("final", bid1, salt1, { value: bid1 });
      await auction.connect(bidder2).revealBid("final", bid2, salt2, { value: bid2 });

      await time.increase(oneDay + 1);
    });

    it("Should allow winner to finalize auction", async function () {
      await expect(
        auction.connect(bidder2).finalizeAuction("final", oneYear, await resolver.getAddress())
      ).to.emit(auction, "AuctionFinalized")
       .and.to.emit(registry, "DomainRegistered");

      // Check domain registration
      const node = await registry.getNodeOfLabel("final");
      const domain = await registry.getDomain(node);
      expect(domain.owner).to.equal(bidder2.address);
    });

    it("Should implement Vickrey pricing (winner pays second highest)", async function () {
      const bidder2BalanceBefore = await ethers.provider.getBalance(bidder2.address);
      
      const tx = await auction.connect(bidder2).finalizeAuction(
        "final", 
        oneYear, 
        await resolver.getAddress()
      );
      
      const receipt = await tx.wait();
      const gasUsed = receipt!.gasUsed * receipt!.gasPrice;
      const bidder2BalanceAfter = await ethers.provider.getBalance(bidder2.address);

      // Winner should get refund of (highest_bid - second_highest_bid)
      const expectedRefund = bid2 - bid1;
      const actualCost = bidder2BalanceBefore - bidder2BalanceAfter - gasUsed;
      
      expect(actualCost).to.equal(bid1); // Should pay second highest bid
    });

    it("Should reject finalization by non-winner", async function () {
      await expect(
        auction.connect(bidder1).finalizeAuction("final", oneYear, await resolver.getAddress())
      ).to.be.revertedWith("Not the winner");
    });

    it("Should reject finalization before auction ends", async function () {
      await auction.startAuction("early", 2 * oneDay, oneDay, minBid);
      
      await expect(
        auction.connect(bidder1).finalizeAuction("early", oneYear, await resolver.getAddress())
      ).to.be.revertedWith("Auction not ended");
    });

    it("Should handle auction with no valid bids", async function () {
      await auction.startAuction("nobids", 2 * oneDay, oneDay, minBid);
      await time.increase(4 * oneDay);

      await expect(
        auction.connect(bidder1).finalizeAuction("nobids", oneYear, await resolver.getAddress())
      ).to.be.revertedWith("No valid bids");
    });
  });

  describe("Emergency Functions", function () {
    beforeEach(async function () {
      await auction.startAuction("emergency", 2 * oneDay, oneDay, minBid);
    });

    it("Should allow admin to cancel auction", async function () {
      await expect(
        auction.cancelAuction("emergency")
      ).to.emit(auction, "AuctionCancelled");

      const auctionData = await auction.getAuction("emergency");
      expect(auctionData.state).to.equal(4); // Cancelled
    });

    it("Should refund bidders on cancellation", async function () {
      const bid = ethers.parseEther("1.0");
      const salt = ethers.keccak256(ethers.toUtf8Bytes("salt"));
      const commitment = await auction.generateCommitment(bid, salt, bidder1.address);

      await auction.connect(bidder1).commitBid("emergency", commitment);
      await time.increase(2 * oneDay + 1);
      await auction.connect(bidder1).revealBid("emergency", bid, salt, { value: bid });

      const balanceBefore = await ethers.provider.getBalance(bidder1.address);
      await auction.cancelAuction("emergency");
      const balanceAfter = await ethers.provider.getBalance(bidder1.address);

      expect(balanceAfter - balanceBefore).to.equal(bid);
    });

    it("Should allow emergency withdrawal", async function () {
      const contractBalance = await ethers.provider.getBalance(await auction.getAddress());
      
      if (contractBalance > 0) {
        const ownerBalanceBefore = await ethers.provider.getBalance(owner.address);
        await auction.emergencyWithdraw();
        const ownerBalanceAfter = await ethers.provider.getBalance(owner.address);

        expect(ownerBalanceAfter).to.be.gt(ownerBalanceBefore);
      }
    });
  });

  describe("Utility Functions", function () {
    it("Should generate correct commitment hash", async function () {
      const bid = ethers.parseEther("1.0");
      const salt = ethers.keccak256(ethers.toUtf8Bytes("testsalt"));
      
      const commitment = await auction.generateCommitment(bid, salt, bidder1.address);
      const expectedCommitment = ethers.keccak256(
        ethers.concat([
          ethers.toBeArray(bid),
          salt,
          ethers.getBytes(bidder1.address)
        ])
      );

      expect(commitment).to.equal(expectedCommitment);
    });
  });
});