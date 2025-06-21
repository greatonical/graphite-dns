import { expect } from "chai";
import { ethers } from "hardhat";
import type { GraphiteDNSRegistry, GraphiteResolver } from "../typechain";

describe("GraphiteDNSRegistry", function () {
  let resolver: GraphiteResolver;
  let registry: GraphiteDNSRegistry;
  let owner: any, addr1: any, addr2: any;
  const oneYear = 365 * 24 * 3600;

  beforeEach(async () => {
    [owner, addr1, addr2] = await ethers.getSigners();

    resolver = (await ethers.deployContract(
      "GraphiteResolver",
      [],
      owner
    )) as GraphiteResolver;

    registry = (await ethers.deployContract(
      "GraphiteDNSRegistry",
      [resolver.target],
      owner
    )) as GraphiteDNSRegistry;
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
    const ev = receipt.events?.find((x: any) => x.event === "DomainRegistered");
    expect(ev).to.exist;

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
      registry.connect(addr1).buyFixedPrice(
        "charlie",
        ethers.ZeroAddress,
        oneYear,
        { value: price - 1n }
      )
    ).to.be.revertedWith("Insufficient ETH");

    await registry.connect(addr1).buyFixedPrice(
      "charlie",
      ethers.ZeroAddress,
      oneYear,
      { value: price }
    );
    expect(await registry.ownerOf(2)).to.equal(addr1.address);
  });
});
