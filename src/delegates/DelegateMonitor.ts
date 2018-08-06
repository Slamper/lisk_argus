import { PeerManager } from "../peers/PeerManager";
import * as events from "events";
import * as _ from "underscore";
import * as log from "winston";
import { Block, DelegateDetails, ForgerDetail, ForgerMeta } from "../lib/HttpApi";

/***
 * The DelegateMonitor keeps track of the delegate ranks and forging status of delegates on a Lisk chain
 */
export class DelegateMonitor extends events.EventEmitter {
  public static readonly EVENT_DELEGATE_RANK_CHANGE = "d_rank_change";
  public static readonly EVENT_DELEGATE_NEW_TOP = "d_new_top";
  public static readonly EVENT_DELEGATE_DROPPED_TOP = "d_dropped_top";
  public static readonly EVENT_DELEGATE_STATUS_CHANGED = "d_status_changed";
  public static readonly EVENT_DELEGATE_BLOCK_MISSED = "d_block_missed";

  private blocks: Map<Number, Block> = new Map<Number, Block>();
  private delegates: Map<String, Delegate> = new Map<String, Delegate>();
  private nextForgers: ForgerDetail[] = [];
  private lastForger: Delegate | undefined;
  private currentSlot: number;

  /***
   * Instantiates the DelegateMonitor
   * @param {PeerManager} peerManager
   */
  constructor(readonly peerManager: PeerManager) {
    super();
    this.peerManager = peerManager;
  }

  /***
   * Starts the update loop of delegates
   * @returns {Promise<void>}
   */
  public start(): Promise<void> {
    // Start update ticks
    const updateFunction = () => {
      this.update()
        .then(() => {
          setTimeout(updateFunction, 2000);
        })
        .catch(err => log.error(err));
    };

    return this.update()
      .catch(err => log.error(err))
      .then(() => {
        updateFunction();
      });
  }

  /***
   * Runs one update cycle
   * 1. Update Delegate list - emit event in case of changes in the forging delegates list
   * 1. Refresh blocks on the chain
   * 2. Update Forger list for this round
   * 3. Determine the forging status of the delegates - emit events in case of dropped blocks etc.
   *
   * TODO refactor to use peers from only one chain
   * @returns {Promise<void>}
   */
  private update(): Promise<void> {
    return this.updateDelegates()
      .then(() => this.updateForgers())
      .then(() => this.updateBlocks())
      .then(() => this.updateDelegateStatus());
  }

  /***
   * Updates the forging status of the delegates
   * Detect dropped blocks etc.
   */
  private updateDelegateStatus(): void {
    let bestHeight = this.peerManager.getBestHeight();
    for (let [key, delegate] of this.delegates) {
      let oldStatus = delegate.status;
      delegate.update(bestHeight);

      if (delegate.status != oldStatus) {
        this.emit(
          DelegateMonitor.EVENT_DELEGATE_STATUS_CHANGED,
          delegate,
          oldStatus,
          delegate.status,
        );
      }
    }
  }

  /***
   * Get new forger list from peer and process it
   * @returns {Promise<void>}
   */
  private updateForgers(): Promise<void> {
    return this.peerManager
      .getBestHTTPPeer()
      .client.http.getForgers()
      .then(response => this.processForgers(response.data, response.meta));
  }

  /***
   * Process a list of forgers from an API response
   * @param {Array<ForgerDetail>} forgers
   * @param {ForgerMeta} slotDetails
   */
  private processForgers(forgers: Array<ForgerDetail>, slotDetails: ForgerMeta): void {
    // If a slot is over check whether the last forger actually forged a block
    // We grant the network a 1 slot period for the block to spread otherwise it is probably missed
    if (this.currentSlot < slotDetails.currentSlot) {
      const bestHeight = _.max(Array.from(this.blocks.keys())) as number;
      if (
        this.lastForger &&
        this.lastForger.details &&
        this.blocks.get(bestHeight)!.generatorPublicKey !==
          this.lastForger.details.account.publicKey &&
        this.blocks.get(bestHeight - 1)!.generatorPublicKey !==
          this.lastForger.details.account.publicKey &&
        this.blocks.get(bestHeight - 2)!.generatorPublicKey !==
          this.lastForger.details.account.publicKey
      ) {
        this.emit(DelegateMonitor.EVENT_DELEGATE_BLOCK_MISSED, this.lastForger);
      }

      this.lastForger = this.delegates.get(this.nextForgers[0].publicKey);
    }

    this.nextForgers = forgers;
    let roundDelegates = getRoundDelegates(this.nextForgers, this.peerManager.getBestHeight());
    for (let forger of forgers) {
      const delegate = this.delegates.get(forger.publicKey);
      if (!delegate) continue;
      delegate.nextSlot = forger.nextSlot;
      delegate.isRoundDelegate =
        roundDelegates.filter(item => {
          return forger.publicKey == item.publicKey;
        }).length != 0;
    }

    this.currentSlot = slotDetails.currentSlot;
  }

  /***
   * Get latest blocks from peer and process them
   * @returns {Promise<void>}
   */
  private updateBlocks(): Promise<void> {
    return this.peerManager
      .getBestHTTPPeer()
      .client.http.getBlocks()
      .then(response => this.processBlocks(response.data));
  }

  /***
   * Process the blocks from the API and update the delegate's last forged block
   * @param {Array<Block>} blocks
   * @returns {Promise<void>}
   */
  private async processBlocks(blocks: Array<Block>): Promise<void> {
    for (let block of blocks) {
      if (this.blocks.has(block.height)) continue;

      this.blocks.set(block.height, block);

      const delegate = this.delegates.get(block.generatorPublicKey);
      if (delegate && (!delegate.lastBlock || delegate.lastBlock.height < block.height)) {
        delegate.lastBlock = block;
      }
    }

    for (let delegate of this.delegates.values()) {
      if (delegate.details && delegate.details.producedBlocks > 0 && !delegate.lastBlock) {
        delegate.lastBlock = await this.peerManager
          .getBestHTTPPeer()
          .client.http.getLastBlockByDelegate(delegate.details.account.publicKey);
      }
    }
  }

  /***
   * Get the delegate list from a peer and process it
   * @returns {Promise<void>}
   */
  private updateDelegates(): Promise<void> {
    return this.peerManager
      .getBestHTTPPeer()
      .client.http.getDelegates()
      .then(response => this.processDelegates(response.data));
  }

  /***
   * Process the delegate list from an API response
   * Detect changes in the forging delegate list
   * @param {Array<DelegateDetails>} delegates
   */
  private processDelegates(delegates: Array<DelegateDetails>): void {
    let delegateMap = new Map<String, DelegateDetails>();
    for (let delegate of delegates) {
      delegateMap.set(delegate.account.publicKey, delegate);
    }

    let newDelegates = _.difference(
      Array.from(delegateMap.keys()),
      Array.from(this.delegates.keys()),
    );
    let droppedDelegates = _.difference(
      Array.from(this.delegates.keys()),
      Array.from(delegateMap.keys()),
    );

    // Handle rank updates
    for (let [key, delegateDetails] of delegateMap) {
      const delegate = this.delegates.get(delegateDetails.account.publicKey);
      if (delegate && delegate.details) {
        if (delegate.details.rank != delegateDetails.rank) {
          this.handleDelegateRankChanged(
            delegateDetails,
            delegateDetails.rank - delegate.details.rank,
          );
        }
      }
    }

    // Handle new delegates in 101
    for (let key of newDelegates) {
      this.handleNewDelegate(delegateMap.get(key)!);
    }

    // Handle dropped delegates from 101
    for (let key of droppedDelegates) {
      this.handleDroppedDelegate(this.delegates.get(key)!.details!);
    }

    // Update details
    for (let [key, delegateDetails] of delegateMap) {
      const delegate = this.delegates.get(delegateDetails.account.publicKey);
      if (delegate) {
        delegate.details = delegateDetails;
      }
    }
  }

  /***
   * Handle a delegate rank change
   * @param delegate affected delegate
   * @param diff rank difference (negative if rank is better now) e.g. 22=>20=-2
   */
  private handleDelegateRankChanged(delegate: DelegateDetails, diff: number): void {
    this.emit(DelegateMonitor.EVENT_DELEGATE_RANK_CHANGE, delegate, diff);
  }

  /***
   * Handle a new delegate in the forging list
   * @param {DelegateDetails} delegate affected delegate
   */
  private handleNewDelegate(delegate: DelegateDetails): void {
    this.delegates.set(delegate.account.publicKey, new Delegate());
    this.emit(DelegateMonitor.EVENT_DELEGATE_NEW_TOP, delegate);
  }

  /***
   * Handle a delegate dropping from the forging list
   * @param {DelegateDetails} delegate affected delegate
   */
  private handleDroppedDelegate(delegate: DelegateDetails): void {
    this.delegates.delete(delegate.account.publicKey);
    this.emit(DelegateMonitor.EVENT_DELEGATE_DROPPED_TOP, delegate);
  }
}

/***
 * Delegate is a delegate with forging information
 */
export class Delegate {
  status: DelegateStatus;
  lastBlock: Block;
  nextSlot: Number;
  isRoundDelegate: Boolean;
  public details: DelegateDetails | undefined;

  /***
   * Updates the current forging status of a delegate
   * @param {number} height current network height
   * @returns {void}
   */
  public update(height: number): void {
    if (!this.details) return;

    const networkRound = getRound(height);
    let awaitingSlot = -1;
    let delegateRound;
    if (this.lastBlock != null) {
      delegateRound = getRound(this.lastBlock.height);
      awaitingSlot = networkRound - delegateRound;
    } else if (this.details.producedBlocks == 0) {
      awaitingSlot = -1;
    }

    if (awaitingSlot === 0) {
      // Forged block in current round
      this.status = DelegateStatus.FORGED_THIS_ROUND;
    } else if (awaitingSlot === -1) {
      // New delegate that never forged a block
      this.status = DelegateStatus.NEW;
    } else if (!this.isRoundDelegate && awaitingSlot === 1) {
      // Missed block in current round
      this.status = DelegateStatus.MISSED_THIS_BLOCK;
    } else if (!this.isRoundDelegate && awaitingSlot > 1) {
      // Missed block in current and last round = not forging
      this.status = DelegateStatus.MISSED_MORE;
    } else if (awaitingSlot === 1) {
      // Awaiting slot, but forged in last round
      this.status = DelegateStatus.AWAITING_FORGED_LAST;
    } else if (awaitingSlot === 2) {
      // Awaiting slot, but missed block in last round
      this.status = DelegateStatus.AWAITING_MISSED_LAST;
    } else if (awaitingSlot > 1) {
      // Awaiting slot, but missed block in more than 1 rounds
      this.status = DelegateStatus.AWAITING_MISSED_MORE;
    }
  }
}

/***
 * Determine the round from the network height
 * @param height network block height
 * @returns {number} round a that height
 */
function getRound(height: number): number {
  return Math.ceil(height / 101);
}

/***
 * Get the delegates from the list that still have to forge this round
 * @param {ForgerDetail[]} nextForgers list of forging delegate details
 * @param {number} height current network height
 * @returns {ForgerDetail[]} delegates that still have to forge in that round
 */
function getRoundDelegates(nextForgers: ForgerDetail[], height: number): ForgerDetail[] {
  const currentRound = getRound(height);
  return nextForgers.filter((delegate, index) => currentRound === getRound(height + index + 1));
}

/***
 * DelegateStatus indicates the forging status of a delegate
 */
export enum DelegateStatus {
  FORGED_THIS_ROUND,
  MISSED_THIS_BLOCK,
  MISSED_MORE,
  AWAITING_MISSED_LAST,
  AWAITING_MISSED_MORE,
  AWAITING_FORGED_LAST,
  NEW,
}
