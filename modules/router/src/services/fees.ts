import {
  FullChannelState,
  GAS_ESTIMATES,
  IVectorChainReader,
  jsonifyError,
  Result,
  REDUCED_GAS_PRICE,
} from "@connext/vector-types";
import {
  calculateExchangeWad,
  getBalanceForAssetId,
  getParticipant,
  getRandomBytes32,
  inverse,
  logAxiosError,
} from "@connext/vector-utils";
import { BigNumber } from "@ethersproject/bignumber";
import { AddressZero, Zero } from "@ethersproject/constants";
import axios from "axios";
import { BaseLogger } from "pino";

import { FeeError } from "../errors";
import { getDecimals } from "../metrics";

import { getRebalanceProfile, getSwapFees } from "./config";
import { getSwappedAmount } from "./swap";

// Takes in some proposed amount in toAssetId and returns the
// fees in the toAssetId. Will *NOT* return an error if fees > amount
export const calculateFeeAmount = async (
  transferAmount: BigNumber,
  fromAssetId: string,
  fromChannel: FullChannelState,
  toAssetId: string,
  toChannel: FullChannelState,
  ethReader: IVectorChainReader,
  routerPublicIdentifier: string,
  logger: BaseLogger,
): Promise<Result<BigNumber, FeeError>> => {
  const method = "calculateFeeAmount";
  const methodId = getRandomBytes32();
  logger.info(
    {
      method,
      methodId,
      startingAmount: transferAmount.toString(),
      fromAssetId,
      fromChainId: fromChannel.networkContext.chainId,
      fromChannel: fromChannel.channelAddress,
      toChainId: toChannel.networkContext.chainId,
      toAssetId,
      toChannel: toChannel.channelAddress,
    },
    "Method start",
  );
  const toChainId = toChannel.networkContext.chainId;
  const fromChainId = fromChannel.networkContext.chainId;
  // Get fee values from config
  const fees = getSwapFees(fromAssetId, fromChainId, toAssetId, toChainId);
  if (fees.isError) {
    return Result.fail(
      new FeeError(FeeError.reasons.ConfigError, {
        getFeesError: jsonifyError(fees.getError()!),
      }),
    );
  }
  const { flatFee, percentageFee, gasSubsidyPercentage } = fees.getValue();
  const isSwap = fromChainId !== toChainId || fromAssetId !== toAssetId;
  logger.debug(
    {
      method,
      methodId,
      flatFee,
      percentageFee,
      dynamicGasFee: gasSubsidyPercentage,
    },
    "Got fee rates",
  );

  // Calculate fees only on starting amount and update
  const feeFromPercent = transferAmount.mul(percentageFee).div(100);
  const staticFees = feeFromPercent.add(flatFee);
  if (gasSubsidyPercentage === 100) {
    // gas is fully subsidized
    logger.info(
      {
        method,
        methodId,
        startingAmount: transferAmount.toString(),
        staticFees: staticFees.toString(),
        withStaticFees: staticFees.add(transferAmount).toString(),
      },
      "Method complete",
    );
    return Result.ok(staticFees);
  }

  logger.debug(
    {
      method,
      methodId,
      startingAmount: transferAmount.toString(),
      staticFees: staticFees.toString(),
    },
    "Calculating gas fee",
  );

  // Calculate gas fees for transfer
  const gasFeesRes = await calculateEstimatedGasFee(
    transferAmount, // in fromAsset
    toAssetId,
    fromAssetId,
    fromChannel,
    toChannel,
    ethReader,
    routerPublicIdentifier,
    logger,
  );
  if (gasFeesRes.isError) {
    return Result.fail(gasFeesRes.getError()!);
  }
  const gasFees = gasFeesRes.getValue();

  // After getting the gas fees for reclaim and for collateral, we
  // must convert them to the proper value in the `fromAsset` (the same asset
  // that the transfer amount is given in).
  // NOTE: only *mainnet* gas fees are assessed here. If you are reclaiming
  // on chain1, include reclaim fees. If you are collateralizing on chain1,
  // include collateral fees
  const normalizedReclaimFromAsset =
    fromChainId === 1 // fromAsset MUST be on mainnet
      ? await normalizeFee(
          gasFees[fromChannel.channelAddress],
          fromAssetId,
          fromChainId,
          ethReader,
          logger,
          REDUCED_GAS_PRICE, // assume reclaim actions happen at reduced price
        )
      : Result.ok(Zero);
  const normalizedCollateralToAsset =
    toChainId === 1 // toAsset MUST be on mainnet
      ? await normalizeFee(gasFees[toChannel.channelAddress], toAssetId, toChainId, ethReader, logger)
      : Result.ok(Zero);

  if (normalizedReclaimFromAsset.isError || normalizedCollateralToAsset.isError) {
    return Result.fail(
      new FeeError(FeeError.reasons.ExchangeRateError, {
        message: "Could not normalize fees",
        fromChainId,
        toChainId,
        toAssetId,
        normalizedCollateralToAsset: normalizedCollateralToAsset.isError
          ? jsonifyError(normalizedCollateralToAsset.getError())
          : normalizedCollateralToAsset.getValue().toString(),
        normalizedCollateral: normalizedCollateralToAsset.isError
          ? jsonifyError(normalizedCollateralToAsset.getError())
          : normalizedCollateralToAsset.getValue().toString(),
      }),
    );
  }

  // Now that you have the normalized collateral values, you must use the
  // swap config to get the normalized collater in the desired `fromAsset`.
  // We know the to/from swap is supported, and we do *not* know if they are
  // both on mainnet (i.e. we do not have an oracle)
  const normalizedCollateralFromAsset = isSwap
    ? await getSwappedAmount(
        normalizedCollateralToAsset.getValue().toString(),
        toAssetId,
        toChainId,
        fromAssetId,
        fromChainId,
      )
    : Result.ok(normalizedCollateralToAsset.getValue().toString());
  if (normalizedCollateralFromAsset.isError) {
    return Result.fail(
      new FeeError(FeeError.reasons.ConversionError, {
        toChainId,
        toAssetId,
        fromChainId,
        fromAssetId,
        conversionError: jsonifyError(normalizedCollateralFromAsset.getError()!),
        normalizedCollateralToAsset: normalizedCollateralToAsset.getValue().toString(),
      }),
    );
  }

  const normalizedGasFees = normalizedReclaimFromAsset.getValue().add(normalizedCollateralFromAsset.getValue());
  // take the subsidy percentage of the normalized fees
  const dynamic = normalizedGasFees.mul(100 - gasSubsidyPercentage).div(100);
  const totalFees = staticFees.add(dynamic);
  logger.info(
    {
      method,
      methodId,
      startingAmount: transferAmount.toString(),
      staticFees: staticFees.toString(),
      normalizedGasFees: normalizedGasFees.toString(),
      totalFees: totalFees.toString(),
      withFees: BigNumber.from(transferAmount).sub(totalFees).toString(),
    },
    "Method complete",
  );

  // returns the total fees applied to transfer
  return Result.ok(totalFees);
};

// This function returns the cost in wei units. it is in the `normalize`
// function where this is properly converted to the `toAsset` units
// NOTE: it will return an object keyed on chain id to indicate which
// chain the fees are charged on. these fees will have to be normalized
// separately, then added together.

// E.g. consider the case where transferring from mainnet --> matic
// the fees there are:
// (1) collateralizing on matic
// (2) reclaiming on mainnet
// Because we don't have l2 prices of tokens/l2 base assets, we cannot
// normalize the collateralization fees. However, we can normalize the
// reclaim fees
export const calculateEstimatedGasFee = async (
  amountToSend: BigNumber, // in fromAsset
  toAssetId: string,
  fromAssetId: string,
  fromChannel: FullChannelState,
  toChannel: FullChannelState,
  ethReader: IVectorChainReader,
  routerPublicIdentifier: string,
  logger: BaseLogger,
): Promise<Result<{ [channelAddress: string]: BigNumber }, FeeError>> => {
  const method = "calculateDynamicFee";
  const methodId = getRandomBytes32();
  logger.info(
    {
      method,
      methodId,
      amountToSend: amountToSend.toString(),
      toChannel: toChannel.channelAddress,
    },
    "Method start",
  );

  // the sender channel will have the following possible actions based on the
  // rebalance profile:
  // (1) IFF current balance + transfer amount > reclaimThreshold, reclaim
  // (2) IFF current balance + transfer amount < collateralThreshold,
  //     collateralize
  const participantFromChannel = getParticipant(fromChannel, routerPublicIdentifier);
  if (!participantFromChannel) {
    return Result.fail(
      new FeeError(FeeError.reasons.ChannelError, {
        message: "Not in channel",
        publicIdentifier: routerPublicIdentifier,
        alice: fromChannel.aliceIdentifier,
        bob: fromChannel.bobIdentifier,
        channelAddress: fromChannel.channelAddress,
      }),
    );
  }
  // Determine final balance (assuming successful transfer resolution)
  const finalFromBalance = amountToSend.add(getBalanceForAssetId(fromChannel, fromAssetId, participantFromChannel));

  // Actions in channel will depend on contract being deployed, so get that
  const fromChannelCode = await ethReader.getCode(fromChannel.channelAddress, fromChannel.networkContext.chainId);
  if (fromChannelCode.isError) {
    return Result.fail(
      new FeeError(FeeError.reasons.ChainError, {
        fromChainId: fromChannel.networkContext.chainId,
        fromChannel: fromChannel.channelAddress,
        getCodeError: jsonifyError(fromChannelCode.getError()!),
      }),
    );
  }

  // Get the rebalance profile
  const rebalanceFromProfile = getRebalanceProfile(fromChannel.networkContext.chainId, fromAssetId);
  if (rebalanceFromProfile.isError) {
    return Result.fail(
      new FeeError(FeeError.reasons.ConfigError, {
        message: "Failed to get rebalance profile",
        assetId: fromAssetId,
        chainId: fromChannel.networkContext.chainId,
        error: jsonifyError(rebalanceFromProfile.getError()!),
      }),
    );
  }

  const fromProfile = rebalanceFromProfile.getValue();
  let fromChannelFee = Zero; // start with no actions
  if (finalFromBalance.gt(fromProfile.reclaimThreshold)) {
    // There will be a post-resolution reclaim of funds
    fromChannelFee =
      fromChannelCode.getValue() === "0x"
        ? GAS_ESTIMATES.createChannel.add(GAS_ESTIMATES.withdraw)
        : GAS_ESTIMATES.withdraw;
  } else if (finalFromBalance.lt(fromProfile.collateralizeThreshold)) {
    // There will be a post-resolution sender collateralization
    fromChannelFee =
      participantFromChannel === "bob"
        ? GAS_ESTIMATES.depositBob
        : fromChannelCode.getValue() === "0x" // is alice, is deployed?
        ? GAS_ESTIMATES.createChannelAndDepositAlice
        : GAS_ESTIMATES.depositAlice;
  }

  // when forwarding a transfer, the only immediate costs on the receiver-side
  // are the ones needed to properly collateralize the transfer

  // there are several conditions that would effect the collateral costs
  // (1) channel has sufficient collateral: none
  // (2) participant == alice && contract not deployed: createChannelAndDeposit
  // (3) participant == alice && contract deployed: depositAlice
  // (4) participant == bob && contract not deployed: depositBob (channel does
  //     not need to be created for a deposit to be recognized offchain)
  // (5) participant == bob && contract deployed: depositBob

  const participantToChannel = getParticipant(toChannel, routerPublicIdentifier);
  if (!participantToChannel) {
    return Result.fail(
      new FeeError(FeeError.reasons.ChannelError, {
        message: "Not in channel",
        publicIdentifier: routerPublicIdentifier,
        alice: toChannel.aliceIdentifier,
        bob: toChannel.bobIdentifier,
        channelAddress: toChannel.channelAddress,
      }),
    );
  }
  const routerBalance = getBalanceForAssetId(toChannel, toAssetId, participantToChannel);
  // get the amount you would send
  const converted = await getSwappedAmount(
    amountToSend.toString(),
    fromAssetId,
    fromChannel.networkContext.chainId,
    toAssetId,
    toChannel.networkContext.chainId,
  );
  if (converted.isError) {
    return Result.fail(
      new FeeError(FeeError.reasons.ConversionError, {
        swapError: jsonifyError(converted.getError()!),
      }),
    );
  }
  if (BigNumber.from(routerBalance).gte(converted.getValue())) {
    // channel has balance, no extra gas required to facilitate transfer
    logger.info(
      { method, methodId, routerBalance: routerBalance.toString(), amountToSend: amountToSend.toString() },
      "Channel is collateralized",
    );
    return Result.ok({
      [fromChannel.channelAddress]: fromChannelFee,
      [toChannel.channelAddress]: Zero,
    });
  }
  logger.info(
    {
      method,
      methodId,
      routerBalance: routerBalance.toString(),
      amountToSend: amountToSend.toString(),
      participant: participantToChannel,
    },
    "Channel is undercollateralized",
  );

  // If participant is bob, then you don't need to worry about deploying
  // the channel contract
  if (participantToChannel === "bob") {
    return Result.ok({
      [fromChannel.channelAddress]: fromChannelFee,
      [toChannel.channelAddress]: GAS_ESTIMATES.depositBob,
    });
  }

  // Determine if channel needs to be deployed to properly calculate the
  // collateral fee
  const toChannelCode = await ethReader.getCode(toChannel.channelAddress, toChannel.networkContext.chainId);
  if (toChannelCode.isError) {
    return Result.fail(
      new FeeError(FeeError.reasons.ChainError, {
        toChainId: toChannel.networkContext.chainId,
        getCodeError: jsonifyError(toChannelCode.getError()!),
      }),
    );
  }
  return Result.ok({
    [fromChannel.channelAddress]: fromChannelFee,
    [toChannel.channelAddress]:
      toChannelCode.getValue() === "0x" ? GAS_ESTIMATES.createChannelAndDepositAlice : GAS_ESTIMATES.depositAlice,
  });
};

// function to calculate gas fee amount multiplied by gas price in the
// toAsset units. some caveats:
// - there is no l2 exchange rate feed, so it is not possible to get the
//   rates from l2BaseAsset --> toAsset
// - there is no great way to determine *which* asset is the l2BaseAsset
//
// because of the above reasons, if the `toChainId` is *not* mainnet, then
// the function returns an error. this is enforced in router config validation
// as well
export const normalizeFee = async (
  fee: BigNumber,
  desiredFeeAssetId: string, // asset you want fee denominated in
  chainId: number,
  ethReader: IVectorChainReader,
  logger: BaseLogger,
  gasPriceOverride?: BigNumber,
): Promise<Result<BigNumber, FeeError>> => {
  const method = "normalizeFee";
  const methodId = getRandomBytes32();
  logger.info(
    { method, methodId, fee: fee.toString(), toAssetId: desiredFeeAssetId, toChainId: chainId },
    "Method start",
  );
  if (chainId !== 1) {
    return Result.fail(
      new FeeError(FeeError.reasons.ChainError, {
        message: "Cannot get normalize fees that are not going to mainnet",
        toAssetId: desiredFeeAssetId,
        toChainId: chainId,
        fee: fee.toString(),
      }),
    );
  }

  let gasPrice = gasPriceOverride;
  if (!gasPriceOverride) {
    const gasPriceRes = await ethReader.getGasPrice(chainId);
    if (gasPriceRes.isError) {
      return Result.fail(
        new FeeError(FeeError.reasons.ChainError, { getGasPriceError: jsonifyError(gasPriceRes.getError()!) }),
      );
    }
    gasPrice = gasPriceRes.getValue();
  }
  const feeWithGasPrice = fee.mul(gasPrice!);

  if (desiredFeeAssetId === AddressZero) {
    logger.info({ method, methodId }, "Eth detected, exchange rate not required");
    return Result.ok(feeWithGasPrice);
  }

  const exchangeRateRes = await getExchangeRateInEth(desiredFeeAssetId, logger);
  if (exchangeRateRes.isError) {
    return Result.fail(exchangeRateRes.getError()!);
  }
  const exchangeRate = exchangeRateRes.getValue();

  // since rate is ETH : token, need to invert
  const invertedRate = inverse(exchangeRate.toString());
  let decimals: number;
  let baseAssetDecimals: number;
  try {
    decimals = await getDecimals(chainId.toString(), desiredFeeAssetId);
    baseAssetDecimals = await getDecimals(chainId.toString(), AddressZero);
  } catch (e) {
    return Result.fail(
      new FeeError(FeeError.reasons.ExchangeRateError, {
        message: "Could not get decimals",
        invertedRate,
        toAssetId: desiredFeeAssetId,
        toChainId: chainId,
      }),
    );
  }

  // total fee in asset normalized decimals
  const feeWithGasPriceInAsset = calculateExchangeWad(feeWithGasPrice, baseAssetDecimals, invertedRate, decimals);
  return Result.ok(BigNumber.from(feeWithGasPriceInAsset));
};

export const getExchangeRateInEth = async (
  tokenAddress: string,
  logger: BaseLogger,
): Promise<Result<number, FeeError>> => {
  const uri = `https://api.coingecko.com/api/v3/simple/token_price/ethereum?contract_addresses=${tokenAddress}&vs_currencies=eth`;
  logger.info({ uri }, "Getting exchange rate");
  try {
    const response = await axios.get<{ [token: string]: { eth: number } }>(uri);
    logger.info({ uri, response: response.data }, "Got exchange rate");
    if (!response.data[tokenAddress]?.eth) {
      return Result.fail(
        new FeeError(FeeError.reasons.ExchangeRateError, {
          message: "Could not find rate in response",
          response: response.data,
          tokenAddress,
        }),
      );
    }
    return Result.ok(response.data[tokenAddress].eth);
  } catch (e) {
    logAxiosError(logger, e);
    return Result.fail(
      new FeeError(FeeError.reasons.ExchangeRateError, {
        message: "Could not get exchange rate",
        tokenAddress,
        error: e.message,
      }),
    );
  }
};
