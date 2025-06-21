import { expect } from "chai";
import { ethers, artifacts } from "hardhat";
import type { ReverseRegistrar } from "../typechain";

describe("ReverseRegistrar", function () {
  let reverse: ReverseRegistrar;
  let owner: any, other: any;
  const name = "alice.atgraphite";

  beforeEach(async () => {
    [owner, other] = await ethers.getSigners();

    const art     = await artifacts.readArtifact("ReverseRegistrar");
    const factory = new ethers.ContractFactory(art.abi, art.bytecode, owner);
    reverse       = (await factory.deploy()) as ReverseRegistrar;
    await reverse.waitForDeployment();
  });

  it("allows only REVERSE_ROLE to set reverse and anyone to get", async () => {
    await expect(reverse.connect(other).setReverse(name)).to.be.reverted;
    await reverse.setReverse(name);
    expect(await reverse.getReverse(owner.address)).to.equal(name);
  });
});
