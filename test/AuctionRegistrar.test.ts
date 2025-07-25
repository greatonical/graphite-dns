// test/AuctionRegistrar.test.ts
import { expect } from "chai";
import { ethers } from "hardhat";
import { GraphiteDNSRegistry, GraphiteResolver, AuctionRegistrar } from "../typechain";
import "@nomicfoundation/hardhat-chai-matchers";

describe("AuctionRegistrar", function () {
  let registry: GraphiteDNSRegistry;
  let resolver: GraphiteResolver;
  let auctionRegistrar: AuctionRegistrar;
  let owner: any;
  let bidder1: any;
  let bidder2: any;

  beforeEach(async () => {
    [owner, bidder1, bidder2] = await ethers.getSigners();

    const ResolverFactory = await ethers.getContractFactory("GraphiteResolver");
    resolver = await ResolverFactory.deploy(ethers.ZeroAddress);
    
    const RegistryFactory = await ethers.getContractFactory("GraphiteDNSRegistry");
    registry = await RegistryFactory.deploy(await resolver.getAddress());
    
    resolver = await ResolverFactory.deploy(await registry.getAddress());
    
    const AuctionFactory = await ethers.getContractFactory("AuctionRegistrar");
    auctionRegistrar = await AuctionFactory.deploy(await registry.getAddress());

    const REGISTRAR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("REGISTRAR_ROLE"));
    await registry.grantRole(REGISTRAR_ROLE, await auctionRegistrar.getAddress());
  });

  describe("Auction Creation", () => {
    it("Should start auction correctly", async () => {
      await expect(
        auctionRegistrar.startAuction("premium", 2 * 3600, 1 * 3600)
      ).to.emit(auctionRegistrar, "AuctionStarted");
    });
  });

  describe("Bidding Process", () => {
    beforeEach(async () => {
      await auctionRegistrar.startAuction("auction", 2 * 3600, 1 * 3600);
    });

    it("Should accept bid commitments", async () => {
      const bid = ethers.parseEther("1.0");
      const salt = ethers.randomBytes(32);
      const commitment = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["address", "uint256", "bytes32"],
          [bidder1.address, bid, salt]
        )
      );

      await expect(
        auctionRegistrar.connect(bidder1).commitBid("auction", commitment)
      ).to.emit(auctionRegistrar, "BidCommitted");
    });
  });
});
