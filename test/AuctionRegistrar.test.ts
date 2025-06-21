import { expect } from "chai";
import { ethers, artifacts, network } from "hardhat";
import type {
  GraphiteResolver,
  GraphiteDNSRegistry,
  AuctionRegistrar
} from "../typechain";

describe("AuctionRegistrar", function () {
  let resolver: GraphiteResolver;
  let registry: GraphiteDNSRegistry;
  let auction: AuctionRegistrar;
  let owner: any, bidder1: any;

  const bidAmount = ethers.parseEther("1.0");
  const salt      = ethers.keccak256(ethers.toUtf8Bytes("salty"));
  const oneYear   = 365 * 24 * 3600;

  beforeEach(async () => {
    [owner, bidder1] = await ethers.getSigners();

    // 1) Deploy GraphiteResolver
    const resArt     = await artifacts.readArtifact("GraphiteResolver");
    const resFactory = new ethers.ContractFactory(resArt.abi, resArt.bytecode, owner);
    resolver         = (await resFactory.deploy()) as GraphiteResolver;
    await resolver.waitForDeployment();

    // 2) Deploy the core registry
    const regArt     = await artifacts.readArtifact("GraphiteDNSRegistry");
    const regFactory = new ethers.ContractFactory(regArt.abi, regArt.bytecode, owner);
    registry         = (await regFactory.deploy(resolver.target)) as GraphiteDNSRegistry;
    await registry.waitForDeployment();

    // 3) Deploy the AuctionRegistrar module
    const aucArt     = await artifacts.readArtifact("AuctionRegistrar");
    const aucFactory = new ethers.ContractFactory(aucArt.abi, aucArt.bytecode, owner);
    auction         = (await aucFactory.deploy(registry.target)) as AuctionRegistrar;
    await auction.waitForDeployment();

    // 4) Grant the module permission to mint in the registry
    const role = await registry.REGISTRAR_ROLE();
    await registry.grantRole(role, auction.getAddress());
  });

  it("runs a blind auction and mints to the winner", async () => {
    const label  = "rare";
    const parent = await auction.TLD_NODE();

    // start a 1s commit / 2s reveal auction
    await auction.startAuction(label, 1, 2);

    // commit phase
    const packed  = ethers.solidityPacked(
      ["uint256", "bytes32"],
      [bidAmount, salt]
    );
    const bidHash = ethers.keccak256(packed);
    await auction.connect(bidder1).commitBid(label, bidHash);

    // advance 2s into the reveal window
    await network.provider.send("evm_increaseTime", [2]);
    await network.provider.send("evm_mine");

    // reveal phase
    await auction.connect(bidder1).revealBid(
      label,
      bidAmount,
      salt,
      { value: bidAmount }
    );

    // advance past reveal window
    await network.provider.send("evm_increaseTime", [2]);
    await network.provider.send("evm_mine");

    // finalize & mint the name via registry
    await auction.connect(bidder1).finalizeAuction(
      label,
      bidder1.address,
      oneYear,
      ethers.ZeroAddress,
      parent
    );

    // **ASSERT** via registry, not auction
    expect(await registry.ownerOf(2)).to.equal(bidder1.address);
  });
});
