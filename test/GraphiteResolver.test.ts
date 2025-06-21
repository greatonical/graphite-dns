import { expect } from "chai";
import { ethers } from "hardhat";
import type { GraphiteResolver } from "../typechain";

describe("GraphiteResolver", function () {
  let resolver: GraphiteResolver;
  let owner: any, other: any;
  const node = ethers.ZeroHash;
  const KEY = "avatar";
  const VALUE = "ipfs://cid";

  beforeEach(async () => {
    [owner, other] = await ethers.getSigners();

    resolver = (await ethers.deployContract(
      "GraphiteResolver",
      [],
      owner
    )) as GraphiteResolver;
  });

  it("allows only RESOLVER_ROLE to set and anyone to read", async () => {
    await expect(resolver.connect(other).setText(node, KEY, VALUE)).to.be.reverted;
    await resolver.setText(node, KEY, VALUE);
    expect(await resolver.text(node, KEY)).to.equal(VALUE);
  });
});
