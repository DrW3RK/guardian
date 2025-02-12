import Big from 'big.js';
import { Subject } from 'rxjs';
import { concatMap } from 'rxjs/operators';
import { ActionRegistry } from '@open-web3/guardian';
import { CollateralAuction, Event } from '@open-web3/guardian/types';
import { FixedPointNumber } from '@acala-network/sdk-core';
import { OrmlAccountData, Balance } from '@open-web3/orml-types/interfaces';
import config from './config';
import setupAcalaApi from '../setupAcalaApi';
import setupKeyring from '../setupKeyring';
import { setDefaultConfig, logger, tokenPrecision } from '../utils';
import { calculateBid } from './calculateBid';
import { ApiManager } from '@open-web3/api';

type Metadata = {
  network: string;
  nodeEndpoint: string | string[];
  action: { margin: number };
};

const getDexPrice = async (apiManager: ApiManager, stableCoin: any, currencyId: any) => {
  const stableCoinPrecision = await tokenPrecision(apiManager.api, stableCoin.asToken.toString());

  // collateral token precision
  const precision = await tokenPrecision(apiManager.api, currencyId);

  // calculate dex price
  const baseCurrency = apiManager.api.createType('CurrencyId', stableCoin);
  const otherCurrency = apiManager.api.createType('CurrencyId', { token: currencyId });
  const [base, other] = await apiManager.api.query.dex.liquidityPool<[Balance, Balance]>([baseCurrency, otherCurrency]);

  const _other = FixedPointNumber.fromInner(other.toString(), precision);
  const _base = FixedPointNumber.fromInner(base.toString(), stableCoinPrecision);
  if (_other.isZero()) throw Error('Other liquidity is zero');
  const price = _base.div(_other);
  price.setPrecision(18);

  return price._getInner().toFixed(0);
};

export default async () => {
  setDefaultConfig('collateral-auction-guardian.yml');

  const { address, SURI } = config();
  const { signer } = await setupKeyring(SURI, address);

  let _apiManager: ApiManager;
  const getApiManager = async (nodeEndpoint: string | string[]): Promise<ApiManager> => {
    if (!_apiManager) {
      const api = await setupAcalaApi(nodeEndpoint);
      _apiManager = api.apiManager;
      return _apiManager;
    }
    return _apiManager;
  };

  const auction$ = new Subject<[CollateralAuction, Metadata]>();
  const auctionDealt$ = new Subject<[Event, Metadata]>();

  const onAuction = async (auction: CollateralAuction, metadata: Metadata) => {
    const {
      nodeEndpoint,
      action: { margin }
    } = metadata;
    const apiManager = await getApiManager(nodeEndpoint);

    const stableCoin = apiManager.api.consts.cdpEngine.getStableCurrencyId;
    const balance = await apiManager.api.query.tokens.accounts<OrmlAccountData>(address, stableCoin);

    const stableCoinPrecision = await tokenPrecision(apiManager.api, stableCoin.asToken.toString());
    const collateralPrecision = await tokenPrecision(apiManager.api, auction.currencyId);

    const price = await getDexPrice(apiManager, stableCoin, auction.currencyId);

    const bid = await calculateBid(auction, price, margin, stableCoinPrecision, collateralPrecision);

    // simple check for enough balance
    if (Big(balance.free.toString()).lt(bid)) {
      throw Error('Not enough balance to place the bid');
    }

    const tx = apiManager.api.tx.auction.bid(auction.auctionId, bid);
    await apiManager.signAndSend(tx, { account: signer }).inBlock;
  };

  const onAuctionDealt = async (event: Event, metadata: Metadata) => {
    const currencyId = event.args['collateral_type'] || event.args['1'];
    const amount = event.args['collateral_amount'] || event.args['2'];

    const { nodeEndpoint } = metadata;
    const apiManager = await getApiManager(nodeEndpoint);

    const stableCoin = apiManager.api.consts.cdpEngine.getStableCurrencyId;
    const tx = apiManager.api.tx.dex.swapWithExactSupply([currencyId, stableCoin], amount, 0);
    await apiManager.signAndSend(tx, { account: signer }).inBlock;
  };

  auction$
    .pipe(concatMap(async ([auction, metadata]) => await onAuction(auction, metadata).catch((e) => logger.error(e))))
    .subscribe();

  auctionDealt$
    .pipe(concatMap(async ([event, metadata]) => await onAuctionDealt(event, metadata).catch((e) => logger.error(e))))
    .subscribe();

  // register `collateral_auction_created` action to feed `auction$` with data
  ActionRegistry.register('collateral_auction_created', (data: CollateralAuction, metadata: Metadata) => {
    auction$.next([data, metadata]);
  });

  // register `collateral_auction_dealt` action to feed `auctionDealt$` with data
  ActionRegistry.register('collateral_auction_dealt', (data: Event, metadata: Metadata) => {
    auctionDealt$.next([data, metadata]);
  });

  // start guardian
  require('@open-web3/guardian-cli');
};
