import { ethers, waffle } from 'hardhat'
import { BigNumber, BigNumberish, constants, Wallet } from 'ethers'
import { TestERC20 } from '../typechain/TestERC20'
import { UniswapV3Factory } from '../typechain/UniswapV3Factory'
import { MockTimeUniswapV3Pair } from '../typechain/MockTimeUniswapV3Pair'
import { expect } from './shared/expect'

import { pairFixture, TEST_PAIR_START_TIME } from './shared/fixtures'
import snapshotGasCost from './shared/snapshotGasCost'

import {
  expandTo18Decimals,
  FeeAmount,
  getPositionKey,
  getMaxTick,
  getMinTick,
  encodePriceSqrt,
  TICK_SPACINGS,
  createPairFunctions,
  SwapFunction,
  MintFunction,
  InitializeFunction,
  getMaxLiquidityPerTick,
} from './shared/utilities'
import { TestUniswapV3Callee } from '../typechain/TestUniswapV3Callee'
import { SqrtTickMathTest } from '../typechain/SqrtTickMathTest'
import { SwapMathTest } from '../typechain/SwapMathTest'

const createFixtureLoader = waffle.createFixtureLoader

type ThenArg<T> = T extends PromiseLike<infer U> ? U : T

describe('UniswapV3Pair', () => {
  const [wallet, other] = waffle.provider.getWallets()

  let token0: TestERC20
  let token1: TestERC20
  let token2: TestERC20

  let factory: UniswapV3Factory
  let pair: MockTimeUniswapV3Pair

  let swapTarget: TestUniswapV3Callee

  let swapToLowerPrice: SwapFunction
  let swapToHigherPrice: SwapFunction
  let swapExact0For1: SwapFunction
  let swap0ForExact1: SwapFunction
  let swapExact1For0: SwapFunction
  let swap1ForExact0: SwapFunction

  let feeAmount: number
  let tickSpacing: number

  let minTick: number
  let maxTick: number

  let mint: MintFunction
  let initialize: InitializeFunction

  let loadFixture: ReturnType<typeof createFixtureLoader>
  let createPair: ThenArg<ReturnType<typeof pairFixture>>['createPair']

  before('create fixture loader', async () => {
    loadFixture = createFixtureLoader([wallet, other])
  })

  beforeEach('deploy fixture', async () => {
    ;({ token0, token1, token2, factory, createPair, swapTarget } = await loadFixture(pairFixture))

    const oldCreatePair = createPair
    createPair = async (_feeAmount, _tickSpacing) => {
      const pair = await oldCreatePair(_feeAmount, _tickSpacing)
      ;({
        swapToLowerPrice,
        swapToHigherPrice,
        swapExact0For1,
        swap0ForExact1,
        swapExact1For0,
        swap1ForExact0,
        mint,
        initialize,
      } = createPairFunctions({
        token0,
        token1,
        swapTarget,
        pair,
      }))
      minTick = getMinTick(_tickSpacing)
      maxTick = getMaxTick(_tickSpacing)
      feeAmount = _feeAmount
      tickSpacing = _tickSpacing
      return pair
    }

    // default to the 30 bips pair
    pair = await createPair(FeeAmount.MEDIUM, TICK_SPACINGS[FeeAmount.MEDIUM])
  })

  it('constructor initializes immutables', async () => {
    expect(await pair.factory()).to.eq(factory.address)
    expect(await pair.token0()).to.eq(token0.address)
    expect(await pair.token1()).to.eq(token1.address)
    expect(await pair.minTick()).to.eq(minTick)
    expect(await pair.maxTick()).to.eq(maxTick)
    expect(await pair.maxLiquidityPerTick()).to.eq(getMaxLiquidityPerTick(tickSpacing))
  })

  describe('#initialize', () => {
    it('fails if already initialized', async () => {
      await initialize(encodePriceSqrt(1, 1))
      await expect(initialize(encodePriceSqrt(1, 1))).to.be.revertedWith('AI')
    })
    it('fails if starting price is too low', async () => {
      await expect(initialize(1)).to.be.revertedWith('R')
    })
    it('fails if starting price is too high', async () => {
      await expect(initialize(BigNumber.from(2).pow(160).sub(1))).to.be.revertedWith('R')
    })
    it('fails if starting price is too low or high', async () => {
      const minTick = await pair.minTick()
      const maxTick = await pair.maxTick()

      const sqrtTickMath = (await (await ethers.getContractFactory('SqrtTickMathTest')).deploy()) as SqrtTickMathTest
      const badMinPrice = (await sqrtTickMath.getSqrtRatioAtTick(minTick)).sub(1)
      const badMaxPrice = await sqrtTickMath.getSqrtRatioAtTick(maxTick)

      await expect(initialize(badMinPrice)).to.be.revertedWith('MIN')
      await expect(initialize(badMaxPrice)).to.be.revertedWith('MAX')
    })
    it('sets initial variables', async () => {
      const price = encodePriceSqrt(1, 2)
      await initialize(price)
      const { sqrtPriceX96, blockTimestampLast } = await pair.slot0()
      expect(sqrtPriceX96).to.eq(price)
      expect(blockTimestampLast).to.eq(TEST_PAIR_START_TIME)
      expect(await pair.tickCurrent()).to.eq(-6932)
      expect(await pair.liquidity()).to.eq(1)
    })
    it('initializes minTick and maxTick', async () => {
      const price = encodePriceSqrt(1, 2)
      await initialize(price)

      {
        const { liquidityGross, secondsOutside, feeGrowthOutside0X128, feeGrowthOutside1X128 } = await pair.ticks(
          minTick
        )
        expect(liquidityGross).to.eq(1)
        expect(secondsOutside).to.eq(TEST_PAIR_START_TIME)
        expect(feeGrowthOutside0X128).to.eq(0)
        expect(feeGrowthOutside1X128).to.eq(0)
      }
      {
        const { liquidityGross, secondsOutside, feeGrowthOutside0X128, feeGrowthOutside1X128 } = await pair.ticks(
          maxTick
        )
        expect(liquidityGross).to.eq(1)
        expect(secondsOutside).to.eq(0)
        expect(feeGrowthOutside0X128).to.eq(0)
        expect(feeGrowthOutside1X128).to.eq(0)
      }
    })
    it('creates a position for address 0 for min liquidity', async () => {
      const price = encodePriceSqrt(1, 2)
      await initialize(price)
      const { liquidity } = await pair.positions(getPositionKey(constants.AddressZero, minTick, maxTick))
      expect(liquidity).to.eq(1)
    })
    it('emits a Initialized event with the input tick', async () => {
      const price = encodePriceSqrt(1, 2)
      await expect(initialize(price)).to.emit(pair, 'Initialized').withArgs(price, -6932)
    })
    it('transfers the token', async () => {
      const price = encodePriceSqrt(1, 2)
      await expect(initialize(price))
        .to.emit(token0, 'Transfer')
        .withArgs(wallet.address, pair.address, 2)
        .to.emit(token1, 'Transfer')
        .withArgs(wallet.address, pair.address, 1)
      expect(await token0.balanceOf(pair.address)).to.eq(2)
      expect(await token1.balanceOf(pair.address)).to.eq(1)
    })
  })

  describe('#mint', () => {
    it('fails if not initialized', async () => {
      await expect(mint(wallet.address, -tickSpacing, tickSpacing, 0)).to.be.revertedWith('LOK')
    })
    describe('after initialization', () => {
      beforeEach('initialize the pair at price of 10:1', async () => {
        await initialize(encodePriceSqrt(1, 10))
        await mint(wallet.address, minTick, maxTick, 3161)
      })

      describe('failure cases', () => {
        it('fails if tickLower greater than tickUpper', async () => {
          await expect(mint(wallet.address, 1, 0, 1)).to.be.revertedWith('TLU')
        })
        it('fails if tickLower less than min tick', async () => {
          await expect(mint(wallet.address, minTick - 1, 0, 1)).to.be.revertedWith('TLM')
        })
        it('fails if tickUpper greater than max tick', async () => {
          await expect(mint(wallet.address, 0, maxTick + 1, 1)).to.be.revertedWith('TUM')
        })
        it('fails if amount exceeds the max', async () => {
          const maxLiquidityGross = await pair.maxLiquidityPerTick()
          await expect(
            mint(wallet.address, minTick + tickSpacing, maxTick - tickSpacing, maxLiquidityGross.add(1))
          ).to.be.revertedWith('LO')
          await expect(
            mint(wallet.address, minTick + tickSpacing, maxTick - tickSpacing, maxLiquidityGross)
          ).to.not.be.revertedWith('LO')
        })
        it('fails if total amount at tick exceeds the max', async () => {
          await mint(wallet.address, minTick + tickSpacing, maxTick - tickSpacing, 1000)

          const maxLiquidityGross = await pair.maxLiquidityPerTick()
          await expect(
            mint(wallet.address, minTick + tickSpacing, maxTick - tickSpacing, maxLiquidityGross.sub(1000).add(1))
          ).to.be.revertedWith('LO')
          await expect(
            mint(wallet.address, minTick + tickSpacing * 2, maxTick - tickSpacing, maxLiquidityGross.sub(1000).add(1))
          ).to.be.revertedWith('LO')
          await expect(
            mint(wallet.address, minTick + tickSpacing, maxTick - tickSpacing * 2, maxLiquidityGross.sub(1000).add(1))
          ).to.be.revertedWith('LO')
          await expect(
            mint(wallet.address, minTick + tickSpacing, maxTick - tickSpacing, maxLiquidityGross.sub(1000))
          ).to.not.be.revertedWith('LO')
        })
      })

      describe('success cases', () => {
        it('initial balances', async () => {
          expect(await token0.balanceOf(pair.address)).to.eq(10000)
          expect(await token1.balanceOf(pair.address)).to.eq(1001)
        })

        it('initial tick', async () => {
          expect(await pair.tickCurrent()).to.eq(-23028)
        })

        describe('above current price', () => {
          it('transfers token0 only', async () => {
            await expect(mint(wallet.address, -22980, 0, 10000))
              .to.emit(token0, 'Transfer')
              .withArgs(wallet.address, pair.address, 21549)
              .to.not.emit(token1, 'Transfer')
            expect(await token0.balanceOf(pair.address)).to.eq(10000 + 21549)
            expect(await token1.balanceOf(pair.address)).to.eq(1001)
          })

          it('max tick with max leverage', async () => {
            await mint(wallet.address, maxTick - tickSpacing, maxTick, BigNumber.from(2).pow(102))
            expect(await token0.balanceOf(pair.address)).to.eq(10000 + 828011525)
            expect(await token1.balanceOf(pair.address)).to.eq(1001)
          })

          it('works for max tick', async () => {
            await expect(mint(wallet.address, -22980, maxTick, 10000))
              .to.emit(token0, 'Transfer')
              .withArgs(wallet.address, pair.address, 31549)
            expect(await token0.balanceOf(pair.address)).to.eq(10000 + 31549)
            expect(await token1.balanceOf(pair.address)).to.eq(1001)
          })

          it('removing works', async () => {
            await mint(wallet.address, -240, 0, 10000)
            await pair.burn(wallet.address, -240, 0, 10000)
            expect(await token0.balanceOf(pair.address)).to.eq(10001)
            expect(await token1.balanceOf(pair.address)).to.eq(1001)
          })

          it('adds liquidity to liquidityGross', async () => {
            await mint(wallet.address, -240, 0, 100)
            expect((await pair.ticks(-240)).liquidityGross).to.eq(100)
            expect((await pair.ticks(0)).liquidityGross).to.eq(100)
            expect((await pair.ticks(tickSpacing)).liquidityGross).to.eq(0)
            expect((await pair.ticks(tickSpacing * 2)).liquidityGross).to.eq(0)
            await mint(wallet.address, -240, tickSpacing, 150)
            expect((await pair.ticks(-240)).liquidityGross).to.eq(250)
            expect((await pair.ticks(0)).liquidityGross).to.eq(100)
            expect((await pair.ticks(tickSpacing)).liquidityGross).to.eq(150)
            expect((await pair.ticks(tickSpacing * 2)).liquidityGross).to.eq(0)
            await mint(wallet.address, 0, tickSpacing * 2, 60)
            expect((await pair.ticks(-240)).liquidityGross).to.eq(250)
            expect((await pair.ticks(0)).liquidityGross).to.eq(160)
            expect((await pair.ticks(tickSpacing)).liquidityGross).to.eq(150)
            expect((await pair.ticks(tickSpacing * 2)).liquidityGross).to.eq(60)
          })

          it('removes liquidity from liquidityGross', async () => {
            await mint(wallet.address, -240, 0, 100)
            await mint(wallet.address, -240, 0, 40)
            await pair.burn(wallet.address, -240, 0, 90)
            expect((await pair.ticks(-240)).liquidityGross).to.eq(50)
            expect((await pair.ticks(0)).liquidityGross).to.eq(50)
          })

          it('clears tick lower if last position is removed', async () => {
            await mint(wallet.address, -240, 0, 100)
            await pair.burn(wallet.address, -240, 0, 100)
            const { liquidityGross, feeGrowthOutside0X128, feeGrowthOutside1X128, secondsOutside } = await pair.ticks(
              -240
            )
            expect(liquidityGross).to.eq(0)
            expect(feeGrowthOutside0X128).to.eq(0)
            expect(feeGrowthOutside1X128).to.eq(0)
            expect(secondsOutside).to.eq(0)
          })

          it('clears tick upper if last position is removed', async () => {
            await mint(wallet.address, -240, 0, 100)
            await pair.burn(wallet.address, -240, 0, 100)
            const { liquidityGross, feeGrowthOutside0X128, feeGrowthOutside1X128, secondsOutside } = await pair.ticks(0)
            expect(liquidityGross).to.eq(0)
            expect(feeGrowthOutside0X128).to.eq(0)
            expect(feeGrowthOutside1X128).to.eq(0)
            expect(secondsOutside).to.eq(0)
          })
          it('only clears the tick that is not used at all', async () => {
            await mint(wallet.address, -240, 0, 100)
            await mint(wallet.address, -tickSpacing, 0, 250)
            await pair.burn(wallet.address, -240, 0, 100)

            let { liquidityGross, feeGrowthOutside0X128, feeGrowthOutside1X128, secondsOutside } = await pair.ticks(
              -240
            )
            expect(liquidityGross).to.eq(0)
            expect(feeGrowthOutside0X128).to.eq(0)
            expect(feeGrowthOutside1X128).to.eq(0)
            expect(secondsOutside).to.eq(0)
            ;({ liquidityGross, feeGrowthOutside0X128, feeGrowthOutside1X128, secondsOutside } = await pair.ticks(
              -tickSpacing
            ))
            expect(liquidityGross).to.eq(250)
            expect(feeGrowthOutside0X128).to.eq(0)
            expect(feeGrowthOutside1X128).to.eq(0)
            expect(secondsOutside).to.eq(0)
          })
        })

        describe('including current price', () => {
          it('price within range: transfers current price of both tokens', async () => {
            await expect(mint(wallet.address, minTick + tickSpacing, maxTick - tickSpacing, 100))
              .to.emit(token0, 'Transfer')
              .withArgs(wallet.address, pair.address, 317)
              .to.emit(token1, 'Transfer')
              .withArgs(wallet.address, pair.address, 32)
            expect(await token0.balanceOf(pair.address)).to.eq(10000 + 317)
            expect(await token1.balanceOf(pair.address)).to.eq(1001 + 32)
          })

          it('initializes lower tick', async () => {
            await mint(wallet.address, minTick + tickSpacing, maxTick - tickSpacing, 100)
            const { liquidityGross, secondsOutside } = await pair.ticks(minTick + tickSpacing)
            expect(liquidityGross).to.eq(100)
            expect(secondsOutside).to.eq(TEST_PAIR_START_TIME)
          })

          it('initializes upper tick', async () => {
            await mint(wallet.address, minTick + tickSpacing, maxTick - tickSpacing, 100)
            const { liquidityGross, secondsOutside } = await pair.ticks(maxTick - tickSpacing)
            expect(liquidityGross).to.eq(100)
            expect(secondsOutside).to.eq(0)
          })

          it('works for min/max tick', async () => {
            await expect(mint(wallet.address, minTick, maxTick, 10000))
              .to.emit(token0, 'Transfer')
              .withArgs(wallet.address, pair.address, 31623)
              .to.emit(token1, 'Transfer')
              .withArgs(wallet.address, pair.address, 3163)
            expect(await token0.balanceOf(pair.address)).to.eq(10000 + 31623)
            expect(await token1.balanceOf(pair.address)).to.eq(1001 + 3163)
          })

          it('removing works', async () => {
            await mint(wallet.address, minTick + tickSpacing, maxTick - tickSpacing, 100)
            await pair.burn(wallet.address, minTick + tickSpacing, maxTick - tickSpacing, 100)
            expect(await token0.balanceOf(pair.address)).to.eq(10001)
            expect(await token1.balanceOf(pair.address)).to.eq(1002)
          })
        })

        describe('below current price', () => {
          it('transfers token1 only', async () => {
            await expect(mint(wallet.address, -46080, -23040, 10000))
              .to.emit(token1, 'Transfer')
              .withArgs(wallet.address, pair.address, 2162)
              .to.not.emit(token0, 'Transfer')
            expect(await token0.balanceOf(pair.address)).to.eq(10000)
            expect(await token1.balanceOf(pair.address)).to.eq(1001 + 2162)
          })

          it('min tick with max leverage', async () => {
            await mint(wallet.address, minTick, minTick + tickSpacing, BigNumber.from(2).pow(102))
            expect(await token0.balanceOf(pair.address)).to.eq(10000)
            expect(await token1.balanceOf(pair.address)).to.eq(1001 + 828011520)
          })

          it('works for min tick', async () => {
            await expect(mint(wallet.address, minTick, -23040, 10000))
              .to.emit(token1, 'Transfer')
              .withArgs(wallet.address, pair.address, 3161)
            expect(await token0.balanceOf(pair.address)).to.eq(10000)
            expect(await token1.balanceOf(pair.address)).to.eq(1001 + 3161)
          })

          it('removing works', async () => {
            await mint(wallet.address, -46080, -46020, 10000)
            await pair.burn(wallet.address, -46080, -46020, 10000)
            expect(await token0.balanceOf(pair.address)).to.eq(10000)
            expect(await token1.balanceOf(pair.address)).to.eq(1002)
          })
        })
      })

      it('0 liquidity mint can be used to poke an existing position and accumulate protocol fee', async () => {
        await pair.setFeeTo(wallet.address)

        await mint(wallet.address, minTick + tickSpacing, maxTick - tickSpacing, expandTo18Decimals(1))
        await swapExact0For1(expandTo18Decimals(1).div(10), wallet.address)
        await swapExact1For0(expandTo18Decimals(1).div(100), wallet.address)

        expect(await pair.feeToFees0()).to.eq(0)
        expect(await pair.feeToFees1()).to.eq(0)

        await mint(wallet.address, minTick + tickSpacing, maxTick - tickSpacing, 0)
        expect(await pair.feeToFees0()).to.eq('49999999999999')
        expect(await pair.feeToFees1()).to.eq('4999999999999')
      })

      it('0 liquidity mint can poke existing position before protocol fee is turned on to protect fees', async () => {
        await mint(wallet.address, minTick + tickSpacing, maxTick - tickSpacing, expandTo18Decimals(1))
        await swapExact0For1(expandTo18Decimals(1).div(10), wallet.address)
        await swapExact1For0(expandTo18Decimals(1).div(100), wallet.address)

        expect(await pair.feeToFees0()).to.eq(0)
        expect(await pair.feeToFees1()).to.eq(0)

        await mint(wallet.address, minTick + tickSpacing, maxTick - tickSpacing, 0)
        expect(await pair.feeToFees0()).to.eq(0)
        expect(await pair.feeToFees1()).to.eq(0)

        await pair.setFeeTo(wallet.address)
        await mint(wallet.address, minTick + tickSpacing, maxTick - tickSpacing, 0)
        expect(await pair.feeToFees0()).to.eq(0)
        expect(await pair.feeToFees1()).to.eq(0)
      })

      it('0 liquidity mint is not allowed on uninitialized position', async () => {
        await mint(other.address, minTick + tickSpacing, maxTick - tickSpacing, expandTo18Decimals(1))
        await swapExact0For1(expandTo18Decimals(1).div(10), wallet.address)
        await swapExact1For0(expandTo18Decimals(1).div(100), wallet.address)

        await expect(mint(wallet.address, minTick + tickSpacing, maxTick - tickSpacing, 0)).to.be.revertedWith('NP')

        await mint(wallet.address, minTick + tickSpacing, maxTick - tickSpacing, 1)
        let {
          liquidity,
          feeGrowthInside0LastX128,
          feeGrowthInside1LastX128,
          feesOwed1,
          feesOwed0,
        } = await pair.positions(getPositionKey(wallet.address, minTick + tickSpacing, maxTick - tickSpacing))
        expect(liquidity).to.eq(1)
        expect(feeGrowthInside0LastX128).to.eq('102084710076281216247159121028324689')
        expect(feeGrowthInside1LastX128).to.eq('10208471007628121624715912102832468')
        expect(feesOwed0).to.eq(0)
        expect(feesOwed1).to.eq(0)

        await pair.burn(wallet.address, minTick + tickSpacing, maxTick - tickSpacing, 1)
        ;({
          liquidity,
          feeGrowthInside0LastX128,
          feeGrowthInside1LastX128,
          feesOwed1,
          feesOwed0,
        } = await pair.positions(getPositionKey(wallet.address, minTick + tickSpacing, maxTick - tickSpacing)))
        expect(liquidity).to.eq(0)
        expect(feeGrowthInside0LastX128).to.eq(0)
        expect(feeGrowthInside1LastX128).to.eq(0)
        expect(feesOwed0).to.eq(0)
        expect(feesOwed1).to.eq(0)
      })
    })
  })

  describe('#burn', () => {
    beforeEach('initialize at zero tick', () => initializeAtZeroTick(pair))

    async function checkTickIsClear(tick: number) {
      const {
        liquidityGross,
        secondsOutside,
        feeGrowthOutside0X128,
        feeGrowthOutside1X128,
        liquidityDelta,
      } = await pair.ticks(tick)
      expect(liquidityGross).to.eq(0)
      expect(secondsOutside).to.eq(0)
      expect(feeGrowthOutside0X128).to.eq(0)
      expect(feeGrowthOutside1X128).to.eq(0)
      expect(liquidityDelta).to.eq(0)
    }

    async function checkTickIsNotClear(tick: number) {
      const { liquidityGross } = await pair.ticks(tick)
      expect(liquidityGross).to.not.eq(0)
    }

    it('clears the position fee growth snapshot if no more liquidity', async () => {
      // some activity that would make the ticks non-zero
      await pair.setTime(TEST_PAIR_START_TIME + 10)
      await mint(other.address, minTick, maxTick, expandTo18Decimals(1))
      await swapExact0For1(expandTo18Decimals(1), wallet.address)
      await swapExact1For0(expandTo18Decimals(1), wallet.address)
      await pair.connect(other).burn(wallet.address, minTick, maxTick, expandTo18Decimals(1))
      const {
        liquidity,
        feesOwed0,
        feesOwed1,
        feeGrowthInside0LastX128,
        feeGrowthInside1LastX128,
      } = await pair.positions(getPositionKey(other.address, minTick, maxTick))
      expect(liquidity).to.eq(0)
      expect(feesOwed0).to.not.eq(0)
      expect(feesOwed1).to.not.eq(0)
      expect(feeGrowthInside0LastX128).to.eq(0)
      expect(feeGrowthInside1LastX128).to.eq(0)
    })

    it('clears the tick if its the last position using it', async () => {
      const tickLower = minTick + tickSpacing
      const tickUpper = maxTick - tickSpacing
      // some activity that would make the ticks non-zero
      await pair.setTime(TEST_PAIR_START_TIME + 10)
      await mint(wallet.address, tickLower, tickUpper, 1)
      await swapExact0For1(expandTo18Decimals(1), wallet.address)
      await pair.burn(wallet.address, tickLower, tickUpper, 1)
      await checkTickIsClear(tickLower)
      await checkTickIsClear(tickUpper)
    })

    it('clears only the lower tick if upper is still used', async () => {
      const tickLower = minTick + tickSpacing
      const tickUpper = maxTick - tickSpacing
      // some activity that would make the ticks non-zero
      await pair.setTime(TEST_PAIR_START_TIME + 10)
      await mint(wallet.address, tickLower, tickUpper, 1)
      await mint(wallet.address, tickLower + tickSpacing, tickUpper, 1)
      await swapExact0For1(expandTo18Decimals(1), wallet.address)
      await pair.burn(wallet.address, tickLower, tickUpper, 1)
      await checkTickIsClear(tickLower)
      await checkTickIsNotClear(tickUpper)
    })

    it('clears only the upper tick if lower is still used', async () => {
      const tickLower = minTick + tickSpacing
      const tickUpper = maxTick - tickSpacing
      // some activity that would make the ticks non-zero
      await pair.setTime(TEST_PAIR_START_TIME + 10)
      await mint(wallet.address, tickLower, tickUpper, 1)
      await mint(wallet.address, tickLower, tickUpper - tickSpacing, 1)
      await swapExact0For1(expandTo18Decimals(1), wallet.address)
      await pair.burn(wallet.address, tickLower, tickUpper, 1)
      await checkTickIsNotClear(tickLower)
      await checkTickIsClear(tickUpper)
    })
  })

  // the combined amount of liquidity that the pair is initialized with (including the 1 minimum liquidity that is burned)
  const initializeLiquidityAmount = expandTo18Decimals(2)
  async function initializeAtZeroTick(pair: MockTimeUniswapV3Pair): Promise<void> {
    await initialize(encodePriceSqrt(1, 1))
    const [min, max] = await Promise.all([pair.minTick(), pair.maxTick()])
    await mint(wallet.address, min, max, initializeLiquidityAmount.sub(1))
  }

  describe('#getCumulatives', () => {
    // simulates an external call to get the cumulatives as of the current block timestamp
    async function getCumulatives(): Promise<{ blockTimestamp: number; tickCumulative: BigNumber }> {
      const { tickCumulativeLast, blockTimestampLast } = await pair.slot0()
      const [tickCurrent, time] = await Promise.all([pair.tickCurrent(), pair.time()])
      if (time == blockTimestampLast) return { tickCumulative: tickCumulativeLast, blockTimestamp: blockTimestampLast }
      return {
        tickCumulative: tickCumulativeLast.add(BigNumber.from(tickCurrent).mul(time - blockTimestampLast)),
        blockTimestamp: time,
      }
    }

    beforeEach(() => initializeAtZeroTick(pair))

    it('blockTimestamp is always current timestamp', async () => {
      let { blockTimestamp } = await getCumulatives()
      expect(blockTimestamp).to.eq(TEST_PAIR_START_TIME)
      await pair.setTime(TEST_PAIR_START_TIME + 10)
      ;({ blockTimestamp } = await getCumulatives())
      expect(blockTimestamp).to.eq(TEST_PAIR_START_TIME + 10)
    })

    // zero tick
    it('tick accumulator increases by tick over time', async () => {
      let { tickCumulative } = await getCumulatives()
      expect(tickCumulative).to.eq(0)
      await pair.setTime(TEST_PAIR_START_TIME + 10)
      ;({ tickCumulative } = await getCumulatives())
      expect(tickCumulative).to.eq(0)
    })

    it('tick accumulator after swap', async () => {
      // moves to tick -1
      await swapExact0For1(1000, wallet.address)
      await pair.setTime(TEST_PAIR_START_TIME + 4)
      let { tickCumulative } = await getCumulatives()
      expect(tickCumulative).to.eq(-4)
    })

    it('tick accumulator after two swaps', async () => {
      await swapExact0For1(expandTo18Decimals(1).div(2), wallet.address)
      expect(await pair.tickCurrent()).to.eq(-4452)
      await pair.setTime(TEST_PAIR_START_TIME + 4)
      await swapExact1For0(expandTo18Decimals(1).div(4), wallet.address)
      expect(await pair.tickCurrent()).to.eq(-1558)
      await pair.setTime(TEST_PAIR_START_TIME + 10)
      let { tickCumulative } = await getCumulatives()
      // -4452*4 + -1558*6
      expect(tickCumulative).to.eq(-27156)
    })
  })

  describe('swaps', () => {
    for (const feeAmount of [FeeAmount.LOW, FeeAmount.MEDIUM, FeeAmount.HIGH]) {
      const tickSpacing = TICK_SPACINGS[feeAmount]

      describe(`fee: ${feeAmount}`, () => {
        beforeEach('initialize at zero tick', async () => {
          pair = await createPair(feeAmount, tickSpacing)
          await initializeAtZeroTick(pair)
        })

        describe('swap to price', () => {
          it('swapToLowerPrice', async () => {
            const PRICE = BigNumber.from(2).pow(96).mul(999).div(1000)
            const IN = {
              [FeeAmount.LOW]: '2003203924356617',
              [FeeAmount.MEDIUM]: '2008026080242732',
              [FeeAmount.HIGH]: '2020183654896068',
            }[feeAmount]
            const OUT = '2000000000000000'

            await expect(swapToLowerPrice(PRICE, wallet.address))
              .to.emit(token0, 'Transfer')
              .withArgs(wallet.address, pair.address, IN)
              .to.emit(token1, 'Transfer')
              .withArgs(pair.address, wallet.address, OUT)
            expect((await pair.slot0()).sqrtPriceX96).to.eq(PRICE)
          })

          it('swapToHigherPrice', async () => {
            const PRICE = BigNumber.from(2).pow(96).mul(1001).div(1000)
            const IN = {
              [FeeAmount.LOW]: '2001200720432260',
              [FeeAmount.MEDIUM]: '2006018054162488',
              [FeeAmount.HIGH]: '2018163471241171',
            }[feeAmount]
            const OUT = '1998001998001998'

            await expect(swapToHigherPrice(PRICE, wallet.address))
              .to.emit(token0, 'Transfer')
              .withArgs(pair.address, wallet.address, OUT)
              .to.emit(token1, 'Transfer')
              .withArgs(wallet.address, pair.address, IN)
            expect((await pair.slot0()).sqrtPriceX96).to.eq(PRICE)
          })
        })

        describe('swap 1000 in', () => {
          const IN = 1000
          const OUT = {
            [FeeAmount.LOW]: 998,
            [FeeAmount.MEDIUM]: 996,
            [FeeAmount.HIGH]: 990,
          }[feeAmount]

          it('swapExact0For1', async () => {
            await expect(swapExact0For1(IN, wallet.address))
              .to.emit(token0, 'Transfer')
              .withArgs(wallet.address, pair.address, IN)
              .to.emit(token1, 'Transfer')
              .withArgs(pair.address, wallet.address, OUT)
            expect(await pair.tickCurrent()).to.eq(-1)
          })

          it('swap0ForExact1', async () => {
            await expect(swap0ForExact1(OUT, wallet.address))
              .to.emit(token0, 'Transfer')
              .withArgs(wallet.address, pair.address, IN)
              .to.emit(token1, 'Transfer')
              .withArgs(pair.address, wallet.address, OUT)
            expect(await pair.tickCurrent()).to.eq(-1)
          })

          it('swapExact1For0', async () => {
            await expect(swapExact1For0(IN, wallet.address))
              .to.emit(token0, 'Transfer')
              .withArgs(pair.address, wallet.address, OUT)
              .to.emit(token1, 'Transfer')
              .withArgs(wallet.address, pair.address, IN)
            expect(await pair.tickCurrent()).to.eq(0)
          })

          it('swap1ForExact0', async () => {
            await expect(swap1ForExact0(OUT, wallet.address))
              .to.emit(token0, 'Transfer')
              .withArgs(pair.address, wallet.address, OUT)
              .to.emit(token1, 'Transfer')
              .withArgs(wallet.address, pair.address, IN)
            expect(await pair.tickCurrent()).to.eq(0)
          })
        })

        describe('swap 1e18 in, crossing several initialized ticks', () => {
          const commonTickSpacing = TICK_SPACINGS[FeeAmount.HIGH] // works because this is a multiple of lower fee amounts

          const IN = expandTo18Decimals(1)
          const OUT = {
            [FeeAmount.LOW]: '680406940877446372',
            [FeeAmount.MEDIUM]: '679319045855941784',
            [FeeAmount.HIGH]: '676591598947405339',
          }[feeAmount]

          it('swapExact0For1', async () => {
            await mint(wallet.address, commonTickSpacing * -2, commonTickSpacing * -1, expandTo18Decimals(1))
            await mint(wallet.address, commonTickSpacing * -4, commonTickSpacing * -2, expandTo18Decimals(1))
            await expect(swapExact0For1(IN, wallet.address))
              .to.emit(token0, 'Transfer')
              .withArgs(wallet.address, pair.address, IN)
              .to.emit(token1, 'Transfer')
              .withArgs(pair.address, wallet.address, OUT)
            expect(await pair.tickCurrent()).to.be.lt(commonTickSpacing * -4)
          })

          it('swap0ForExact1', async () => {
            const IN_ADJUSTED = {
              [FeeAmount.LOW]: IN,
              [FeeAmount.MEDIUM]: IN.sub(1),
              [FeeAmount.HIGH]: IN,
            }[feeAmount]

            await mint(wallet.address, commonTickSpacing * -2, commonTickSpacing * -1, expandTo18Decimals(1))
            await mint(wallet.address, commonTickSpacing * -4, commonTickSpacing * -2, expandTo18Decimals(1))
            await expect(swap0ForExact1(OUT, wallet.address))
              .to.emit(token0, 'Transfer')
              .withArgs(wallet.address, pair.address, IN_ADJUSTED)
              .to.emit(token1, 'Transfer')
              .withArgs(pair.address, wallet.address, OUT)
            expect(await pair.tickCurrent()).to.be.lt(commonTickSpacing * -4)
          })

          it('swapExact1For0', async () => {
            await mint(wallet.address, commonTickSpacing, commonTickSpacing * 2, expandTo18Decimals(1))
            await mint(wallet.address, commonTickSpacing * 2, commonTickSpacing * 4, expandTo18Decimals(1))
            await expect(swapExact1For0(IN, wallet.address))
              .to.emit(token0, 'Transfer')
              .withArgs(pair.address, wallet.address, OUT)
              .to.emit(token1, 'Transfer')
              .withArgs(wallet.address, pair.address, IN)
            expect(await pair.tickCurrent()).to.be.gt(commonTickSpacing * 4)
          })

          it('swap1ForExact0', async () => {
            const IN_ADJUSTED = {
              [FeeAmount.LOW]: IN,
              [FeeAmount.MEDIUM]: IN.sub(1),
              [FeeAmount.HIGH]: IN,
            }[feeAmount]

            await mint(wallet.address, commonTickSpacing, commonTickSpacing * 2, expandTo18Decimals(1))
            await mint(wallet.address, commonTickSpacing * 2, commonTickSpacing * 4, expandTo18Decimals(1))
            await expect(swap1ForExact0(OUT, wallet.address))
              .to.emit(token0, 'Transfer')
              .withArgs(pair.address, wallet.address, OUT)
              .to.emit(token1, 'Transfer')
              .withArgs(wallet.address, pair.address, IN_ADJUSTED)
            expect(await pair.tickCurrent()).to.be.gt(commonTickSpacing * 4)
          })
        })
      })
    }
  })

  describe('miscellaneous setPosition tests', () => {
    beforeEach('initialize at zero tick', async () => {
      pair = await createPair(FeeAmount.LOW, TICK_SPACINGS[FeeAmount.LOW])
      await initializeAtZeroTick(pair)
    })

    it('mint to the right of the current price', async () => {
      const liquidityDelta = 1000
      const lowerTick = tickSpacing
      const upperTick = tickSpacing * 2

      const liquidityBefore = await pair.liquidity()

      const b0 = await token0.balanceOf(pair.address)
      const b1 = await token1.balanceOf(pair.address)

      await mint(wallet.address, lowerTick, upperTick, liquidityDelta)

      const liquidityAfter = await pair.liquidity()
      expect(liquidityAfter).to.be.gte(liquidityBefore)

      expect((await token0.balanceOf(pair.address)).sub(b0)).to.eq(1)
      expect((await token1.balanceOf(pair.address)).sub(b1)).to.eq(0)
    })

    it('mint to the left of the current price', async () => {
      const liquidityDelta = 1000
      const lowerTick = -tickSpacing * 2
      const upperTick = -tickSpacing

      const liquidityBefore = await pair.liquidity()

      const b0 = await token0.balanceOf(pair.address)
      const b1 = await token1.balanceOf(pair.address)

      await mint(wallet.address, lowerTick, upperTick, liquidityDelta)

      const liquidityAfter = await pair.liquidity()
      expect(liquidityAfter).to.be.gte(liquidityBefore)

      expect((await token0.balanceOf(pair.address)).sub(b0)).to.eq(0)
      expect((await token1.balanceOf(pair.address)).sub(b1)).to.eq(1)
    })

    it('mint within the current price', async () => {
      const liquidityDelta = 1000
      const lowerTick = -tickSpacing
      const upperTick = tickSpacing

      const liquidityBefore = await pair.liquidity()

      const b0 = await token0.balanceOf(pair.address)
      const b1 = await token1.balanceOf(pair.address)

      await mint(wallet.address, lowerTick, upperTick, liquidityDelta)

      const liquidityAfter = await pair.liquidity()
      expect(liquidityAfter).to.be.gte(liquidityBefore)

      expect((await token0.balanceOf(pair.address)).sub(b0)).to.eq(1)
      expect((await token1.balanceOf(pair.address)).sub(b1)).to.eq(1)
    })

    it('cannot remove more than the entire position', async () => {
      const lowerTick = -tickSpacing
      const upperTick = tickSpacing
      await mint(wallet.address, lowerTick, upperTick, expandTo18Decimals(1000))
      await expect(pair.burn(wallet.address, lowerTick, upperTick, expandTo18Decimals(1001))).to.be.revertedWith('CP')
    })

    it('collect fees within the current price after swap', async () => {
      let liquidityDelta = expandTo18Decimals(100)
      const lowerTick = -tickSpacing * 100
      const upperTick = tickSpacing * 100

      await mint(wallet.address, lowerTick, upperTick, liquidityDelta)

      const k = await pair.liquidity()

      const amount0In = expandTo18Decimals(1)
      await swapExact0For1(amount0In, wallet.address)

      const kAfter = await pair.liquidity()
      expect(kAfter, 'k increases').to.be.gte(k)

      const token0BalanceBeforePair = await token0.balanceOf(pair.address)
      const token1BalanceBeforePair = await token1.balanceOf(pair.address)
      const token0BalanceBeforeWallet = await token0.balanceOf(wallet.address)
      const token1BalanceBeforeWallet = await token1.balanceOf(wallet.address)

      await mint(wallet.address, lowerTick, upperTick, 0) // poke to update fees
      await pair.collect(lowerTick, upperTick, wallet.address, constants.MaxUint256, constants.MaxUint256)

      await mint(wallet.address, lowerTick, upperTick, 0) // poke to update fees
      const { amount0: fees0, amount1: fees1 } = await pair.callStatic.collect(
        lowerTick,
        upperTick,
        wallet.address,
        constants.MaxUint256,
        constants.MaxUint256
      )
      expect(fees0).to.be.eq(0)
      expect(fees1).to.be.eq(0)

      const token0BalanceAfterWallet = await token0.balanceOf(wallet.address)
      const token1BalanceAfterWallet = await token1.balanceOf(wallet.address)
      const token0BalanceAfterPair = await token0.balanceOf(pair.address)
      const token1BalanceAfterPair = await token1.balanceOf(pair.address)

      expect(token0BalanceAfterWallet).to.be.gt(token0BalanceBeforeWallet)
      expect(token1BalanceAfterWallet).to.be.eq(token1BalanceBeforeWallet)

      expect(token0BalanceAfterPair).to.be.lt(token0BalanceBeforePair)
      expect(token1BalanceAfterPair).to.be.eq(token1BalanceBeforePair)
    })
  })

  describe('post-initialize at medium fee', () => {
    describe('k (implicit)', () => {
      it('returns 0 before initialization', async () => {
        expect(await pair.liquidity()).to.eq(0)
      })
      describe('post initialized', () => {
        beforeEach(() => initializeAtZeroTick(pair))

        it('returns initial liquidity', async () => {
          expect(await pair.liquidity()).to.eq(expandTo18Decimals(2))
        })
        it('returns in supply in range', async () => {
          await mint(wallet.address, -tickSpacing, tickSpacing, expandTo18Decimals(3))
          expect(await pair.liquidity()).to.eq(expandTo18Decimals(5))
        })
        it('excludes supply at tick above current tick', async () => {
          await mint(wallet.address, tickSpacing, tickSpacing * 2, expandTo18Decimals(3))
          expect(await pair.liquidity()).to.eq(expandTo18Decimals(2))
        })
        it('excludes supply at tick below current tick', async () => {
          await mint(wallet.address, -tickSpacing * 2, -tickSpacing, expandTo18Decimals(3))
          expect(await pair.liquidity()).to.eq(expandTo18Decimals(2))
        })
        it('updates correctly when exiting range', async () => {
          const kBefore = await pair.liquidity()
          expect(kBefore).to.be.eq(expandTo18Decimals(2))

          // add liquidity at and above current tick
          const liquidityDelta = expandTo18Decimals(1)
          const lowerTick = 0
          const upperTick = tickSpacing
          await mint(wallet.address, lowerTick, upperTick, liquidityDelta)

          // ensure virtual supply has increased appropriately
          const kAfter = await pair.liquidity()
          expect(kAfter).to.be.gt(kBefore)
          expect(kAfter).to.be.eq(expandTo18Decimals(3))

          // swap toward the left (just enough for the tick transition function to trigger)
          // TODO if the input amount is 1 here, the tick transition fires incorrectly!
          // should throw an error or something once the TODOs in pair are fixed
          await swapExact0For1(2, wallet.address)
          const tick = await pair.tickCurrent()
          expect(tick).to.be.eq(-1)

          const kAfterSwap = await pair.liquidity()
          expect(kAfterSwap).to.be.lt(kAfter)
          // TODO not sure this is right
          expect(kAfterSwap).to.be.eq(expandTo18Decimals(2))
        })
        it('updates correctly when entering range', async () => {
          const kBefore = await pair.liquidity()
          expect(kBefore).to.be.eq(expandTo18Decimals(2))

          // add liquidity below the current tick
          const liquidityDelta = expandTo18Decimals(1)
          const lowerTick = -tickSpacing
          const upperTick = 0
          await mint(wallet.address, lowerTick, upperTick, liquidityDelta)

          // ensure virtual supply hasn't changed
          const kAfter = await pair.liquidity()
          expect(kAfter).to.be.eq(kBefore)

          // swap toward the left (just enough for the tick transition function to trigger)
          // TODO if the input amount is 1 here, the tick transition fires incorrectly!
          // should throw an error or something once the TODOs in pair are fixed
          await swapExact0For1(2, wallet.address)
          const tick = await pair.tickCurrent()
          expect(tick).to.be.eq(-1)

          const kAfterSwap = await pair.liquidity()
          expect(kAfterSwap).to.be.gt(kAfter)
          // TODO not sure this is right
          expect(kAfterSwap).to.be.eq(expandTo18Decimals(3))
        })
      })
    })
  })

  describe('limit orders', () => {
    beforeEach('initialize at tick 0', () => initializeAtZeroTick(pair))

    it('selling 1 for 0 at tick 0 thru 1', async () => {
      await expect(mint(wallet.address, 0, 120, expandTo18Decimals(1)))
        .to.emit(token0, 'Transfer')
        .withArgs(wallet.address, pair.address, '5981737760509663')
      // somebody takes the limit order
      await swapExact1For0(expandTo18Decimals(2), other.address)
      await expect(pair.burn(wallet.address, 0, 120, expandTo18Decimals(1)))
        .to.emit(token1, 'Transfer')
        .withArgs(pair.address, wallet.address, '6017734268818165')
    })
    it('selling 0 for 1 at tick 0 thru -1', async () => {
      await expect(mint(wallet.address, -120, 0, expandTo18Decimals(1)))
        .to.emit(token1, 'Transfer')
        .withArgs(wallet.address, pair.address, '5981737760509663')
      // somebody takes the limit order
      await swapExact0For1(expandTo18Decimals(2), other.address)
      await expect(pair.burn(wallet.address, -120, 0, expandTo18Decimals(1)))
        .to.emit(token0, 'Transfer')
        .withArgs(pair.address, wallet.address, '6017734268818165')
    })

    describe('fee is on', () => {
      beforeEach(() => pair.setFeeTo(wallet.address))
      it('selling 1 for 0 at tick 0 thru 1', async () => {
        await expect(mint(wallet.address, 0, 120, expandTo18Decimals(1)))
          .to.emit(token0, 'Transfer')
          .withArgs(wallet.address, pair.address, '5981737760509663')
        // somebody takes the limit order
        await swapExact1For0(expandTo18Decimals(2), other.address)
        await expect(pair.burn(wallet.address, 0, 120, expandTo18Decimals(1)))
          .to.emit(token1, 'Transfer')
          .withArgs(pair.address, wallet.address, '6017734268818165')
      })
      it('selling 0 for 1 at tick 0 thru -1', async () => {
        await expect(mint(wallet.address, -120, 0, expandTo18Decimals(1)))
          .to.emit(token1, 'Transfer')
          .withArgs(wallet.address, pair.address, '5981737760509663')
        // somebody takes the limit order
        await swapExact0For1(expandTo18Decimals(2), other.address)
        await expect(pair.burn(wallet.address, -120, 0, expandTo18Decimals(1)))
          .to.emit(token0, 'Transfer')
          .withArgs(pair.address, wallet.address, '6017734268818165')
      })
    })
  })

  describe('#feeTo', () => {
    const liquidityAmount = expandTo18Decimals(1000)

    beforeEach(async () => {
      pair = await createPair(FeeAmount.LOW, TICK_SPACINGS[FeeAmount.LOW])
      await initialize(encodePriceSqrt(1, 1))
      await mint(wallet.address, minTick, maxTick, liquidityAmount)
    })

    it('is initially set to address 0', async () => {
      expect(await pair.feeTo()).to.eq(constants.AddressZero)
    })

    it('can be changed by the owner', async () => {
      await pair.setFeeTo(other.address)
      expect(await pair.feeTo()).to.eq(other.address)
    })

    it('cannot be changed by addresses that are not owner', async () => {
      await expect(pair.connect(other).setFeeTo(other.address)).to.be.revertedWith('OO')
    })

    async function swapAndGetFeesOwed(
      swapAmount: BigNumberish = expandTo18Decimals(1),
      zeroForOne = true,
      suppressPoke = false
    ) {
      await (zeroForOne ? swapExact0For1(swapAmount, wallet.address) : swapExact1For0(swapAmount, wallet.address))

      if (!suppressPoke) {
        await mint(wallet.address, minTick, maxTick, 0)
      }

      const { amount0: fees0, amount1: fees1 } = await pair.callStatic.collect(
        minTick,
        maxTick,
        wallet.address,
        constants.MaxUint256,
        constants.MaxUint256
      )

      expect(fees0, 'fees owed in token0 are greater than 0').to.be.gte(0)
      expect(fees1, 'fees owed in token1 are greater than 0').to.be.gte(0)

      return { token0Fees: fees0, token1Fees: fees1 }
    }

    it('position owner gets full fees when protocol fee is off', async () => {
      const { token0Fees, token1Fees } = await swapAndGetFeesOwed()

      // 6 bips * 1e18
      expect(token0Fees).to.eq('599999999999999')
      expect(token1Fees).to.eq(0)
    })

    it('swap fees accumulate as expected (0 for 1)', async () => {
      let token0Fees
      let token1Fees
      ;({ token0Fees, token1Fees } = await swapAndGetFeesOwed())
      expect(token0Fees).to.eq('599999999999999')
      expect(token1Fees).to.eq(0)
      ;({ token0Fees, token1Fees } = await swapAndGetFeesOwed())
      expect(token0Fees).to.eq('1199999999999998')
      expect(token1Fees).to.eq(0)
      ;({ token0Fees, token1Fees } = await swapAndGetFeesOwed())
      expect(token0Fees).to.eq('1799999999999997')
      expect(token1Fees).to.eq(0)
    })

    it('swap fees accumulate as expected (1 for 0)', async () => {
      let token0Fees
      let token1Fees
      ;({ token0Fees, token1Fees } = await swapAndGetFeesOwed(undefined, false))
      expect(token0Fees).to.eq(0)
      expect(token1Fees).to.eq('599999999999999')
      ;({ token0Fees, token1Fees } = await swapAndGetFeesOwed(undefined, false))
      expect(token0Fees).to.eq(0)
      expect(token1Fees).to.eq('1199999999999998')
      ;({ token0Fees, token1Fees } = await swapAndGetFeesOwed(undefined, false))
      expect(token0Fees).to.eq(0)
      expect(token1Fees).to.eq('1799999999999997')
    })

    it('position owner gets partial fees when protocol fee is on', async () => {
      await pair.setFeeTo(other.address)

      const { token0Fees, token1Fees } = await swapAndGetFeesOwed()

      expect(token0Fees).to.be.eq('500000000000000')
      expect(token1Fees).to.be.eq(0)
    })

    describe('#collect', () => {
      it('returns 0 if no fees', async () => {
        await pair.setFeeTo(other.address)
        const { amount0, amount1 } = await pair.callStatic.collectProtocol(constants.MaxUint256, constants.MaxUint256)
        expect(amount0).to.be.eq(0)
        expect(amount1).to.be.eq(0)
      })

      it('can collect fees', async () => {
        await pair.setFeeTo(other.address)

        await swapAndGetFeesOwed()
        // collect fees to trigger collection of the protocol fee
        await mint(wallet.address, minTick, maxTick, 0) // poke to update fees
        await pair.collect(minTick, maxTick, wallet.address, constants.MaxUint256, constants.MaxUint256)

        await expect(pair.collectProtocol(constants.MaxUint256, constants.MaxUint256))
          .to.emit(token0, 'Transfer')
          .withArgs(pair.address, other.address, '99999999999999')
      })
    })

    it('fees collected by lp after two swaps should be double one swap', async () => {
      await swapAndGetFeesOwed()
      const { token0Fees, token1Fees } = await swapAndGetFeesOwed()

      // 6 bips * 2e18
      expect(token0Fees).to.eq('1199999999999998')
      expect(token1Fees).to.eq(0)
    })

    it('fees collected after two swaps with fee turned on in middle are fees from both swaps (confiscatory)', async () => {
      await swapAndGetFeesOwed(undefined, undefined, true)

      await pair.setFeeTo(other.address)

      const { token0Fees, token1Fees } = await swapAndGetFeesOwed()

      expect(token0Fees).to.eq('1000000000000000')
      expect(token1Fees).to.eq(0)
    })

    it('fees collected by lp after two swaps with intermediate withdrawal', async () => {
      await pair.setFeeTo(other.address)

      const { token0Fees, token1Fees } = await swapAndGetFeesOwed()

      expect(token0Fees).to.eq('500000000000000')
      expect(token1Fees).to.eq(0)

      // collect the fees
      await pair.collect(minTick, maxTick, wallet.address, constants.MaxUint256, constants.MaxUint256)

      const { token0Fees: token0FeesNext, token1Fees: token1FeesNext } = await swapAndGetFeesOwed(
        undefined,
        undefined,
        true
      )

      expect(token0FeesNext).to.eq(0)
      expect(token1FeesNext).to.eq(0)

      // the fee to fees do not account for uncollected fees yet
      expect(await pair.feeToFees0()).to.be.eq('99999999999999')
      expect(await pair.feeToFees1()).to.be.eq(0)

      await mint(wallet.address, minTick, maxTick, 0) // poke to update fees
      await expect(pair.collect(minTick, maxTick, wallet.address, constants.MaxUint256, constants.MaxUint256))
        .to.emit(token0, 'Transfer')
        .withArgs(pair.address, wallet.address, '500000000000000')

      expect(await pair.feeToFees0()).to.be.eq('199999999999998')
      expect(await pair.feeToFees1()).to.be.eq(0)
    })
  })

  describe('#recover', () => {
    beforeEach('initialize the pair', () => initializeAtZeroTick(pair))

    beforeEach('send some token2 to the pair', async () => {
      await token2.transfer(pair.address, 10)
    })

    it('is only callable by owner', async () => {
      await expect(pair.connect(other).recover(token2.address, other.address, 10)).to.be.revertedWith('OO')
    })

    it('does not allow transferring a token from the pair', async () => {
      await expect(pair.recover(token0.address, other.address, 10)).to.be.revertedWith('TOK')
    })

    it('allows recovery from the pair', async () => {
      await expect(pair.recover(token2.address, other.address, 10))
        .to.emit(token2, 'Transfer')
        .withArgs(pair.address, other.address, 10)
    })
  })

  describe('#tickSpacing', () => {
    it('default tickSpacing is correct', async () => {
      expect(await pair.minTick()).to.eq(minTick)
      expect(await pair.maxTick()).to.eq(maxTick)
    })

    describe('tickSpacing = 12', () => {
      beforeEach('deploy pair', async () => {
        pair = await createPair(FeeAmount.MEDIUM, 12)
      })
      it('min and max tick are multiples of 12', async () => {
        expect(await pair.minTick()).to.eq(-887268)
        expect(await pair.maxTick()).to.eq(887268)
      })
      it('initialize sets min and max ticks', async () => {
        await initialize(encodePriceSqrt(1, 1))
        const { liquidityGross: minTickLiquidityGross } = await pair.ticks(-887268)
        const { liquidityGross: maxLiquidityPerTick } = await pair.ticks(887268)
        expect(minTickLiquidityGross).to.eq(1)
        expect(minTickLiquidityGross).to.eq(maxLiquidityPerTick)
      })
      describe('post initialize', () => {
        beforeEach('initialize pair', async () => {
          await initialize(encodePriceSqrt(1, 1))
        })
        it('mint can only be called for multiples of 12', async () => {
          await expect(mint(wallet.address, -6, 0, 1)).to.be.revertedWith('TS')
          await expect(mint(wallet.address, 0, 6, 1)).to.be.revertedWith('TS')
        })
        it('mint can be called with multiples of 12', async () => {
          await mint(wallet.address, 12, 24, 1)
          await mint(wallet.address, -144, -120, 1)
        })
        it('swapping across gaps works in 1 for 0 direction', async () => {
          const liquidityAmount = expandTo18Decimals(1).div(4)
          await mint(wallet.address, 120000, 121200, liquidityAmount)
          await swapExact1For0(expandTo18Decimals(1), wallet.address)
          await expect(pair.burn(wallet.address, 120000, 121200, liquidityAmount))
            .to.emit(token0, 'Transfer')
            .withArgs(pair.address, wallet.address, '30027458295511')
            .to.emit(token1, 'Transfer')
            .withArgs(pair.address, wallet.address, '996999999999999535')
          expect(await pair.tickCurrent()).to.eq(120196)
        })
        it('swapping across gaps works in 0 for 1 direction', async () => {
          const liquidityAmount = expandTo18Decimals(1).div(4)
          await mint(wallet.address, -121200, -120000, liquidityAmount)
          await swapExact0For1(expandTo18Decimals(1), wallet.address)
          await expect(pair.burn(wallet.address, -121200, -120000, liquidityAmount))
            .to.emit(token0, 'Transfer')
            .withArgs(pair.address, wallet.address, '996999999999999535')
            .to.emit(token1, 'Transfer')
            .withArgs(pair.address, wallet.address, '30027458295511')
          expect(await pair.tickCurrent()).to.eq(-120197)
        })
      })
    })
  })

  // https://github.com/Uniswap/uniswap-v3-core/issues/214
  it('tick transition cannot run twice if zero for one swap ends at fractional price just below tick', async () => {
    pair = await createPair(FeeAmount.MEDIUM, 1)
    const sqrtTickMath = (await (await ethers.getContractFactory('SqrtTickMathTest')).deploy()) as SqrtTickMathTest
    const swapMath = (await (await ethers.getContractFactory('SwapMathTest')).deploy()) as SwapMathTest
    const p0 = (await sqrtTickMath.getSqrtRatioAtTick(-24081)).add(1)
    // initialize at a price of ~0.3 token1/token0
    // meaning if you swap in 2 token0, you should end up getting 0 token1
    await initialize(p0)
    expect(await pair.liquidity(), 'current pair liquidity is 1').to.eq(1)
    expect(await pair.tickCurrent(), 'pair tick is -24081').to.eq(-24081)

    // add a bunch of liquidity around current price
    const liquidity = expandTo18Decimals(1000)
    await mint(wallet.address, -24082, -24080, liquidity)
    expect(await pair.liquidity(), 'current pair liquidity is now liquidity + 1').to.eq(liquidity.add(1))

    await mint(wallet.address, -24082, -24081, liquidity)
    expect(await pair.liquidity(), 'current pair liquidity is still liquidity + 1').to.eq(liquidity.add(1))

    const { secondsOutside: secondsOutsideBefore } = await pair.ticks(-24081)

    // check the math works out to moving the price down 1, sending no amount out, and having some amount remaining
    {
      const { feeAmount, amountIn, amountOut, sqrtQ } = await swapMath.computeSwapStep(
        p0,
        p0.sub(1),
        liquidity.add(1),
        3,
        FeeAmount.MEDIUM
      )
      expect(sqrtQ, 'price moves').to.eq(p0.sub(1))
      expect(feeAmount, 'fee amount is 1').to.eq(1)
      expect(amountIn, 'amount in is 1').to.eq(1)
      expect(amountOut, 'zero amount out').to.eq(0)
    }

    // swap 2 amount in, should get 0 amount out
    await expect(swapExact0For1(3, wallet.address))
      .to.emit(token0, 'Transfer')
      .withArgs(wallet.address, pair.address, 3)
      .to.emit(token1, 'Transfer')
      .withArgs(pair.address, wallet.address, 0)

    const { secondsOutside: secondsOutsideAfter } = await pair.ticks(-24081)

    expect(await pair.tickCurrent(), 'pair is at the next tick').to.eq(-24082)
    expect((await pair.slot0()).sqrtPriceX96, 'pair price is still on the p0 boundary').to.eq(p0.sub(1))
    expect(await pair.liquidity(), 'pair has run tick transition and liquidity changed').to.eq(liquidity.mul(2).add(1))
    expect(secondsOutsideAfter, 'the tick transition updated the seconds outside').to.not.eq(secondsOutsideBefore)
  })

  describe('gas', () => {
    beforeEach('initialize at zero tick', async () => {
      await initializeAtZeroTick(pair)
    })

    const startingPrice = encodePriceSqrt(100001, 100000)
    const startingTick = 0
    const startingTime = TEST_PAIR_START_TIME + 2
    const tickSpacing = TICK_SPACINGS[FeeAmount.MEDIUM]

    beforeEach('do the initial sstores', async () => {
      await swapExact0For1(expandTo18Decimals(1), wallet.address)
      await pair.setTime(TEST_PAIR_START_TIME + 1)
      await swapToHigherPrice(startingPrice, wallet.address)
      await pair.setTime(startingTime)
      expect(await pair.tickCurrent()).to.eq(startingTick)
      expect((await pair.slot0()).sqrtPriceX96).to.eq(startingPrice)
    })

    describe('#swapExact0For1', () => {
      it('first swap in block with no tick movement', async () => {
        await snapshotGasCost(swapExact0For1(10, wallet.address))
        expect((await pair.slot0()).sqrtPriceX96).to.not.eq(startingPrice)
        expect(await pair.tickCurrent()).to.eq(startingTick)
      })

      it('first swap in block moves tick, no initialized crossings', async () => {
        await snapshotGasCost(swapExact0For1(expandTo18Decimals(1).div(10000), wallet.address))
        expect(await pair.tickCurrent()).to.eq(startingTick - 1)
      })

      it('second swap in block with no tick movement', async () => {
        await swapExact0For1(expandTo18Decimals(1).div(10000), wallet.address)
        expect(await pair.tickCurrent()).to.eq(startingTick - 1)
        await snapshotGasCost(swapExact0For1(1000, wallet.address))
        expect(await pair.tickCurrent()).to.eq(startingTick - 1)
      })

      it('second swap in block moves tick, no initialized crossings', async () => {
        await swapExact0For1(1000, wallet.address)
        expect(await pair.tickCurrent()).to.eq(startingTick)
        await snapshotGasCost(swapExact0For1(expandTo18Decimals(1).div(10000), wallet.address))
        expect(await pair.tickCurrent()).to.eq(startingTick - 1)
      })

      it('first swap in block, large swap, no initialized crossings', async () => {
        await snapshotGasCost(swapExact0For1(expandTo18Decimals(10), wallet.address))
        expect(await pair.tickCurrent()).to.eq(-35787)
      })

      it('first swap in block, large swap crossing several initialized ticks', async () => {
        await mint(wallet.address, startingTick - 3 * tickSpacing, startingTick - tickSpacing, expandTo18Decimals(1))
        await mint(
          wallet.address,
          startingTick - 4 * tickSpacing,
          startingTick - 2 * tickSpacing,
          expandTo18Decimals(1)
        )
        expect(await pair.tickCurrent()).to.eq(startingTick)
        await snapshotGasCost(swapExact0For1(expandTo18Decimals(1), wallet.address))
        expect(await pair.tickCurrent()).to.be.lte(startingTick - 4 * tickSpacing) // we crossed the last tick
      })

      it('first swap in block, large swap crossing a single initialized tick', async () => {
        await mint(wallet.address, minTick, startingTick - 2 * tickSpacing, expandTo18Decimals(1))
        await snapshotGasCost(swapExact0For1(expandTo18Decimals(1), wallet.address))
        expect(await pair.tickCurrent()).to.be.lte(startingTick - 2 * tickSpacing) // we crossed the last tick
      })

      it('second swap in block, large swap crossing several initialized ticks', async () => {
        await mint(wallet.address, startingTick - 3 * tickSpacing, startingTick - tickSpacing, expandTo18Decimals(1))
        await mint(
          wallet.address,
          startingTick - 4 * tickSpacing,
          startingTick - 2 * tickSpacing,
          expandTo18Decimals(1)
        )
        await swapExact0For1(expandTo18Decimals(1).div(10000), wallet.address)
        await snapshotGasCost(swapExact0For1(expandTo18Decimals(1), wallet.address))
        expect(await pair.tickCurrent()).to.be.lte(startingTick - 4 * tickSpacing)
      })

      it('second swap in block, large swap crossing a single initialized tick', async () => {
        await mint(wallet.address, minTick, startingTick - 2 * tickSpacing, expandTo18Decimals(1))
        await swapExact0For1(expandTo18Decimals(1).div(10000), wallet.address)
        expect(await pair.tickCurrent()).to.be.gt(startingTick - 2 * tickSpacing) // we didn't cross the initialized tick
        await snapshotGasCost(swapExact0For1(expandTo18Decimals(1), wallet.address))
        expect(await pair.tickCurrent()).to.be.lte(startingTick - 2 * tickSpacing) // we crossed the last tick
      })

      it('large swap crossing several initialized ticks after some time passes (seconds outside is set)', async () => {
        await mint(wallet.address, startingTick - 3 * tickSpacing, startingTick - tickSpacing, expandTo18Decimals(1))
        await mint(
          wallet.address,
          startingTick - 4 * tickSpacing,
          startingTick - 2 * tickSpacing,
          expandTo18Decimals(1)
        )
        await swapExact0For1(2, wallet.address)
        await pair.setTime(TEST_PAIR_START_TIME + 10)
        await snapshotGasCost(swapExact0For1(expandTo18Decimals(1), wallet.address))
        expect(await pair.tickCurrent()).to.be.lte(startingTick - 4 * tickSpacing)
      })

      it('large swap crossing several initialized ticks second time after some time passes', async () => {
        await mint(wallet.address, startingTick - 3 * tickSpacing, startingTick - tickSpacing, expandTo18Decimals(1))
        await mint(
          wallet.address,
          startingTick - 4 * tickSpacing,
          startingTick - 2 * tickSpacing,
          expandTo18Decimals(1)
        )
        await swapExact0For1(expandTo18Decimals(1), wallet.address)
        await swapExact1For0(expandTo18Decimals(1), wallet.address)
        await pair.setTime(TEST_PAIR_START_TIME + 10)
        await snapshotGasCost(swapExact0For1(expandTo18Decimals(1), wallet.address))
        expect(await pair.tickCurrent()).to.be.lt(tickSpacing * -4)
      })
    })

    describe('#mint', () => {
      for (const { description, tickLower, tickUpper } of [
        {
          description: 'around current price',
          tickLower: startingTick - tickSpacing,
          tickUpper: startingTick + tickSpacing,
        },
        {
          description: 'below current price',
          tickLower: startingTick - 2 * tickSpacing,
          tickUpper: startingTick - tickSpacing,
        },
        {
          description: 'above current price',
          tickLower: startingTick + tickSpacing,
          tickUpper: startingTick + 2 * tickSpacing,
        },
      ]) {
        describe(description, () => {
          it('new position mint first in range', async () => {
            await snapshotGasCost(mint(wallet.address, tickLower, tickUpper, expandTo18Decimals(1)))
          })
          it('add to position existing', async () => {
            await mint(wallet.address, tickLower, tickUpper, expandTo18Decimals(1))
            await snapshotGasCost(mint(wallet.address, tickLower, tickUpper, expandTo18Decimals(1)))
          })
          it('second position in same range', async () => {
            await mint(wallet.address, tickLower, tickUpper, expandTo18Decimals(1))
            await snapshotGasCost(mint(other.address, tickLower, tickUpper, expandTo18Decimals(1)))
          })
          it('add to position after some time passes', async () => {
            await mint(wallet.address, tickLower, tickUpper, expandTo18Decimals(1))
            await pair.setTime(startingTime + 1)
            await snapshotGasCost(mint(wallet.address, tickLower, tickUpper, expandTo18Decimals(1)))
          })
        })
      }
    })

    describe('#burn', () => {
      for (const { description, tickLower, tickUpper } of [
        {
          description: 'around current price',
          tickLower: startingTick - tickSpacing,
          tickUpper: startingTick + tickSpacing,
        },
        {
          description: 'below current price',
          tickLower: startingTick - 2 * tickSpacing,
          tickUpper: startingTick - tickSpacing,
        },
        {
          description: 'above current price',
          tickLower: startingTick + tickSpacing,
          tickUpper: startingTick + 2 * tickSpacing,
        },
      ]) {
        describe(description, () => {
          const liquidityAmount = expandTo18Decimals(1)
          beforeEach('mint a position', async () => {
            await mint(wallet.address, tickLower, tickUpper, liquidityAmount)
          })

          it('burn when only position using ticks', async () => {
            await snapshotGasCost(pair.burn(wallet.address, tickLower, tickUpper, expandTo18Decimals(1)))
          })
          it('partial position burn', async () => {
            await snapshotGasCost(pair.burn(wallet.address, tickLower, tickUpper, expandTo18Decimals(1).div(2)))
          })
          it('entire position burn but other positions are using the ticks', async () => {
            await mint(other.address, tickLower, tickUpper, expandTo18Decimals(1))
            await snapshotGasCost(pair.burn(wallet.address, tickLower, tickUpper, expandTo18Decimals(1)))
          })
          it('burn entire position after some time passes', async () => {
            await pair.setTime(startingTime + 1)
            await snapshotGasCost(pair.burn(wallet.address, tickLower, tickUpper, expandTo18Decimals(1)))
          })
        })
      }
    })
  })
})
