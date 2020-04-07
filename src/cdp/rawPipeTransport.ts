/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { ITransport } from './transport';
import { ILogger, LogTag } from '../common/logging';
import { Duplex, Readable, Writable } from 'stream';
import split from 'split2';
import { once } from '../common/objUtils';
import { EventEmitter } from '../common/events';

export class RawPipeTransport implements ITransport {
  private readonly messageEmitter = new EventEmitter<[string, bigint]>();
  private readonly endEmitter = new EventEmitter<void>();

  public readonly onMessage = this.messageEmitter.event;
  public readonly onEnd = this.endEmitter.event;

  private streams?: Readonly<{
    write: Writable;
    read: Readable;
  }>;

  private readonly onceEnded = once(() => {
    if (!this.streams) {
      return;
    }

    this.beforeClose();
    this.streams.read.removeAllListeners();
    // destroy pipeRead, not streams.read, since that will cause any buffered
    // data left in the `split()` transform to error when written.
    this.pipeRead?.destroy();
    this.streams.write.removeListener('end', this.onceEnded);
    this.streams.write.removeListener('error', this.onWriteError);
    this.streams.write.end();
    this.streams = undefined;
    this.endEmitter.fire();
  });

  private readonly onWriteError = (error: Error) => {
    // Suppress pipe errors, e.g. EPIPE when pipe is destroyed with buffered data
    this.logger.error(LogTag.Internal, 'pipeWrite error', { error });
  };

  constructor(logger: ILogger, socket: Duplex);
  constructor(logger: ILogger, pipeWrite: Writable, pipeRead: Readable);

  constructor(
    private readonly logger: ILogger,
    protected readonly pipeWrite: Duplex | Writable,
    protected readonly pipeRead?: Readable,
  ) {
    const read = pipeRead || pipeWrite;
    this.streams = {
      read: read
        .pipe(split('\0'))
        .on('data', json => this.messageEmitter.fire([json, process.hrtime.bigint()]))
        .on('end', this.onceEnded)
        .on('error', error => this.logger.error(LogTag.Internal, 'pipeRead error', { error })),
      write: pipeWrite.on('end', this.onceEnded).on('error', this.onWriteError),
    };
  }

  /**
   * @inheritdoc
   */
  public send(message: string) {
    this.streams?.write.write(message + '\0');
  }

  /**
   * @inheritdoc
   */
  public dispose() {
    this.onceEnded();
  }

  /**
   * Can be overridden to do any last minute finalization before the
   * streams are closed.
   */
  protected beforeClose() {
    // no-op
  }
}