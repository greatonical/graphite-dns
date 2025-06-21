import { expect } from "chai";
import { ethers } from "hardhat";
import type { SubdomainRegistrar, GraphiteResolver } from "../typechain";

describe("SubdomainRegistrar", function () {
  let resolver: GraphiteResolver;
  let sub: SubdomainRegistrar;
  let owner: any, user: any;
  let parentNode: string;
  const oneYear = 365 * 24 * 3600;

  beforeEach(async () => {
    [owner, user] = await ethers.getSigners();

    resolver = (await ethers.deployContract(
      "GraphiteResolver",
      [],
      owner
    )) as GraphiteResolver;

    sub = (await ethers.deployContract(
      "SubdomainRegistrar",
      [resolver.target],
      owner
    )) as SubdomainRegistrar;

    const tld = await sub.TLD_NODE();
    const tx = await sub.register(
      "parent",
      owner.address,
      oneYear,
      ethers.ZeroAddress,
      tld
    );
    const receipt: any = await tx.wait();
    const ev = receipt.events?.find((e: any) => e.event === "DomainRegistered");
    parentNode = ev!.args!.node;
  });

  it("lets parent-owner set price and user buy a subdomain", async () => {
    await sub.setSubdomainPrice(parentNode, "blog", ethers.parseEther("0.2"));
    expect(await sub.priceOfSubdomain(parentNode, "blog")).to.equal(ethers.parseEther("0.2"));

    await expect(
      sub.connect(user).buySubdomainFixedPrice(
        parentNode,
        "blog",
        ethers.ZeroAddress,
        oneYear,
        { value: ethers.parseEther("0.1") }
      )
    ).to.be.revertedWith("Insufficient ETH");

    await sub.connect(user).buySubdomainFixedPrice(
      parentNode,
      "blog",
      ethers.ZeroAddress,
      oneYear,
      { value: ethers.parseEther("0.2") }
    );
    expect(await sub.ownerOf(3)).to.equal(user.address);
  });
});
