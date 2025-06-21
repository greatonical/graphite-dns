import { expect } from "chai";
import { ethers } from "hardhat";
import type { ReverseRegistrar } from "../typechain";

describe("ReverseRegistrar", function () {
  let reverse: ReverseRegistrar;
  let owner: any, other: any;
  const name = "alice.atgraphite";

  beforeEach(async () => {
    [owner, other] = await ethers.getSigners();

    reverse = (await ethers.deployContract(
      "ReverseRegistrar",
      [],
      owner
    )) as ReverseRegistrar;
  });

  it("allows only REVERSE_ROLE to set reverse and anyone to get", async () => {
    await expect(reverse.connect(other).setReverse(name)).to.be.reverted;
    await reverse.setReverse(name);
    expect(await reverse.getReverse(owner.address)).to.equal(name);
  });
});
