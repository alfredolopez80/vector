import {
  ChannelUpdate,
  IMessagingService,
  InboundChannelUpdateError,
  Result,
  VectorMessage,
} from "@connext/vector-types";
import { getRandomBytes32 } from "@connext/vector-utils";
import { Evt } from "evt";

export class MemoryMessagingService implements IMessagingService {
  private readonly evt: Evt<{
    to: string;
    from: string;
    inbox?: string;
    data: {
      update?: ChannelUpdate<any>;
      previousUpdate?: ChannelUpdate<any>;
      error?: InboundChannelUpdateError;
    };
    sentBy: string;
  }> = Evt.create<{
    to: string;
    from: string;
    inbox?: string;
    data: { update?: ChannelUpdate<any>; previousUpdate?: ChannelUpdate<any>; error?: InboundChannelUpdateError };
    sentBy: string;
  }>();

  async connect(): Promise<void> {
    return;
  }

  async sendProtocolMessage(
    channelUpdate: ChannelUpdate<any>,
    previousUpdate?: ChannelUpdate<any>,
    timeout = 20_000,
    numRetries = 0,
  ): Promise<Result<{ update: ChannelUpdate<any>; previousUpdate: ChannelUpdate<any> }, InboundChannelUpdateError>> {
    const inbox = getRandomBytes32();
    const responsePromise = this.evt
      .pipe(
        ({ to, from, inbox, sentBy }) =>
          from === channelUpdate.toIdentifier &&
          to === channelUpdate.fromIdentifier &&
          inbox === inbox &&
          sentBy === channelUpdate.toIdentifier,
      )
      .waitFor(timeout);
    this.evt.post({
      to: channelUpdate.toIdentifier,
      from: channelUpdate.fromIdentifier,
      inbox,
      data: { update: channelUpdate, previousUpdate },
      sentBy: channelUpdate.fromIdentifier,
    });
    const res = await responsePromise;
    if (res.data.error) {
      return Result.fail(res.data.error);
    }
    return Result.ok({ update: res.data.update!, previousUpdate: res.data.previousUpdate! });
  }

  async respondToProtocolMessage(
    sentBy: string,
    channelUpdate: ChannelUpdate<any>,
    inbox: string,
    previousUpdate?: ChannelUpdate<any>,
  ): Promise<void> {
    this.evt.post({
      to: channelUpdate.fromIdentifier,
      from: channelUpdate.toIdentifier,
      inbox,
      data: { update: channelUpdate, previousUpdate },
      sentBy,
    });
  }

  async respondWithProtocolError(
    updateFromIdentifier: string,
    updateToIdentifier: string,
    inbox: string,
    error: InboundChannelUpdateError,
  ): Promise<void> {
    this.evt.post({
      to: updateFromIdentifier,
      from: updateToIdentifier,
      inbox,
      data: { error },
      sentBy: updateToIdentifier,
    });
  }

  async onReceiveProtocolMessage(
    myPublicIdentifier: string,
    callback: (
      result: Result<{ update: ChannelUpdate<any>; previousUpdate: ChannelUpdate<any> }, InboundChannelUpdateError>,
      from: string,
      inbox: string,
    ) => void,
  ): Promise<void> {
    this.evt
      .pipe(({ to }) => to === myPublicIdentifier)
      .attach(({ data, inbox, from }) => {
        callback(
          Result.ok({
            previousUpdate: data.previousUpdate!,
            update: data.update!,
          }),
          from,
          inbox!,
        );
      });
  }

  send(to: string, msg: VectorMessage): Promise<void> {
    throw new Error("Method not implemented.");
  }

  async subscribe(subject: string, callback: (data: any) => void): Promise<void> {
    throw new Error("Method not implemented.");
  }

  request(subject: string, timeout: number, data: any): Promise<any> {
    throw new Error("Method not implemented.");
  }

  async publish(subject: string, data: any): Promise<void> {
    throw new Error("Method not implemented.");
  }

  unsubscribe(subject: string): Promise<void> {
    throw new Error("Method not implemented.");
  }
}
