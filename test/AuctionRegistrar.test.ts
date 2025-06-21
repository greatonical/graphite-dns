import { expect } from "chai";
import { ethers, artifacts, network } from "hardhat";
import type { AuctionRegistrar, GraphiteResolver } from "../typechain";

describe("AuctionRegistrar", function () {
  let resolver: GraphiteResolver;
  let auction: AuctionRegistrar;
  let owner: any, bidder1: any, bidder2: any;
  const bidAmount = ethers.parseEther("1.0");
  const salt = ethers.keccak256(ethers.toUtf8Bytes("salty"));
  const oneYear = 365 * 24 * 3600;

  beforeEach(async () => {
    [owner, bidder1, bidder2] = await ethers.getSigners();

    const resArt = await artifacts.readArtifact("GraphiteResolver");
    const resFactory = new ethers.ContractFactory(resArt.abi, resArt.bytecode, owner);
    resolver = (await resFactory.deploy()) as GraphiteResolver;
    await resolver.waitForDeployment();

    const aucArt = await artifacts.readArtifact("AuctionRegistrar");
    const aucFactory = new ethers.ContractFactory(aucArt.abi, aucArt.bytecode, owner);
    auction = (await aucFactory.deploy(resolver.target)) as AuctionRegistrar;
    await auction.waitForDeployment();
  });

  it("runs a blind auction and mints to the winner", async () => {
    const label = "rare";
    const parent = await auction.TLD_NODE();

    await auction.startAuction(label, 1, 1);

    const bidHash = ethers.keccak256(
      new ethers.AbiCoder().encode(["uint256","bytes32"], [bidAmount, salt])
    );
    await auction.connect(bidder1).commitBid(label, bidHash);

    await network.provider.send("evm_increaseTime", [2]);
    await network.provider.send("evm_mine");

    await auction.connect(bidder1).revealBid(label, bidAmount, salt, { value: bidAmount });

    await network.provider.send("evm_increaseTime", [2]);
    await network.provider.send("evm_mine");

    await auction.connect(bidder1).finalizeAuction(
      label,
      bidder1.address,
      oneYear,
      ethers.ZeroAddress,
      parent
    );

    expect(await auction.ownerOf(2)).to.equal(bidder1.address);
  });
});
