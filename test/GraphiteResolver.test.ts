import { expect } from "chai";
import { ethers, artifacts } from "hardhat";
import type { GraphiteResolver } from "../typechain";

describe("GraphiteResolver", function () {
  let resolver: GraphiteResolver;
  let owner: any, other: any;
  const node  = ethers.ZeroHash;
  const KEY   = "avatar";
  const VALUE = "ipfs://cid";

  beforeEach(async () => {
    [owner, other] = await ethers.getSigners();

    const art     = await artifacts.readArtifact("GraphiteResolver");
    const factory = new ethers.ContractFactory(art.abi, art.bytecode, owner);
    resolver      = (await factory.deploy()) as GraphiteResolver;
    await resolver.waitForDeployment();
  });

  it("allows only RESOLVER_ROLE to set and anyone to read", async () => {
    await expect(resolver.connect(other).setText(node, KEY, VALUE)).to.be.reverted;
    await resolver.setText(node, KEY, VALUE);
    expect(await resolver.text(node, KEY)).to.equal(VALUE);
  });
});
