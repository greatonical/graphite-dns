import { expect } from "chai";
import { ethers, artifacts } from "hardhat";
import type { GraphiteDNSRegistry, GraphiteResolver } from "../typechain";

describe("GraphiteDNSRegistry", function () {
  let resolver: GraphiteResolver;
  let registry: GraphiteDNSRegistry;
  let owner: any, addr1: any, addr2: any;
  const oneYear = 365 * 24 * 3600;

  beforeEach(async () => {
    [owner, addr1, addr2] = await ethers.getSigners();

    // deploy GraphiteResolver
    const resArt = await artifacts.readArtifact("GraphiteResolver");
    const resFactory = new ethers.ContractFactory(resArt.abi, resArt.bytecode, owner);
    resolver = (await resFactory.deploy()) as GraphiteResolver;
    await resolver.waitForDeployment();

    // deploy GraphiteDNSRegistry
    const regArt = await artifacts.readArtifact("GraphiteDNSRegistry");
    const regFactory = new ethers.ContractFactory(regArt.abi, regArt.bytecode, owner);
    registry = (await regFactory.deploy(resolver.target)) as GraphiteDNSRegistry;
    await registry.waitForDeployment();
  });

  it("assigns DEFAULT_ADMIN_ROLE to deployer", async () => {
    const adminRole = await registry.DEFAULT_ADMIN_ROLE();
    expect(await registry.hasRole(adminRole, owner.address)).to.be.true;
  });

  it("allows registrar to register a name", async () => {
    const tx = await registry.register(
      "alice",
      owner.address,
      oneYear,
      ethers.ZeroAddress,
      ethers.ZeroHash
    );
    const receipt: any = await tx.wait();
    expect(receipt.events?.some((e: any) => e.event === "DomainRegistered")).to.be.true;
    expect(await registry.ownerOf(1)).to.equal(owner.address);

    const price = await registry.priceOf("alice");
    expect(typeof price).to.equal("bigint");
  });

  it("only admin can set fixed price", async () => {
    await expect(
      registry.connect(addr1).setFixedPrice("bob", ethers.parseEther("1.0"))
    ).to.be.reverted;
    await registry.setFixedPrice("bob", ethers.parseEther("1.0"));
    expect(await registry.priceOf("bob")).to.equal(ethers.parseEther("1.0"));
  });

  it("lets user buy at fixed price", async () => {
    await registry.setFixedPrice("charlie", ethers.parseEther("0.5"));
    const price = await registry.priceOf("charlie");

    await expect(
      registry.connect(addr1).buyFixedPrice("charlie", ethers.ZeroAddress, oneYear, { value: price - 1n })
    ).to.be.revertedWith("Insufficient ETH");

    await registry.connect(addr1).buyFixedPrice("charlie", ethers.ZeroAddress, oneYear, { value: price });
    expect(await registry.ownerOf(2)).to.equal(addr1.address);
  });
});
