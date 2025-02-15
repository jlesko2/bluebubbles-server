import { Server } from "@server";
import { MessageRepository } from "@server/databases/imessage";
import { EventCache } from "@server/eventCache";
import { getCacheName } from "@server/databases/imessage/helpers/utils";
import { DBWhereItem } from "@server/databases/imessage/types";
import { isNotEmpty, waitMs } from "@server/helpers/utils";
import { ChangeListener } from "./changeListener";

export class OutgoingMessageListener extends ChangeListener {
    repo: MessageRepository;

    notSent: number[];

    constructor(repo: MessageRepository, cache: EventCache, pollFrequency: number) {
        super({ cache, pollFrequency });

        this.repo = repo;
        this.notSent = [];

        // Start the listener
        this.start();
    }

    /**
     * Gets sent entries from yourself. This method has a very different flow
     * from the other listeners. It needs to do a good amount more to be accurate.
     *
     * Flow:
     * 1. Check for any unsent messages (is_sent == 0) from you
     * 2. Check for any sent messages (is_sent == 1) from you
     * 3. Use the "notSent" list to check for any items that
     *    previously weren't sent, but have been sent now
     * 4. Add any unsent messages from step 1 to the "notSent" list
     * 5. Emit the newly sent messages + previously not sent messages from step 3
     * 6. Emit messages that have errored out
     *
     * @param after
     * @param before The time right before get Entries run
     */
    async getEntries(after: Date, before: Date): Promise<void> {
        // Second, emit the outgoing messages (lookback 15 seconds to make up for the "Apple" delay)
        const afterOffsetDate = new Date(after.getTime() - 15000);
        await this.emitOutgoingMessages(afterOffsetDate);

        // Third, check for updated messages
        const afterUpdateOffsetDate = new Date(after.getTime() - this.pollFrequency - 15000);
        await this.emitUpdatedMessages(afterUpdateOffsetDate);
    }

    async emitOutgoingMessages(after: Date) {
        const baseQuery = [
            {
                statement: "message.is_from_me = :fromMe",
                args: { fromMe: 1 }
            }
        ];

        // First, check for unsent messages
        const newUnsent = await this.repo.getMessages({
            after,
            withChats: false,
            withAttachments: false,
            withHandle: false,
            where: [
                ...baseQuery,
                {
                    statement: "message.is_sent = :isSent",
                    args: { isSent: 0 }
                }
            ]
        });

        if (isNotEmpty(newUnsent)) {
            Server().log(`Detected ${newUnsent.length} unsent outgoing message(s)`, "debug");
        }

        // Second, check for sent messages
        const newSent = await this.repo.getMessages({
            after,
            withChats: true,
            where: [
                ...baseQuery,
                {
                    statement: "message.is_sent = :isSent",
                    args: { isSent: 1 }
                }
            ]
        });

        // Make sure none of the "sent" ones include the unsent ones
        const unsent = [];
        for (const us of newUnsent) {
            let found = false;
            for (const s of newSent) {
                if (us.ROWID === s.ROWID) {
                    found = true;
                    break;
                }
            }

            if (!found) {
                unsent.push(us.ROWID);
            }
        }

        // Third, check for anything that hasn't been sent
        const lookbackSent = await this.repo.getMessages({
            withChats: true,
            where: [
                ...baseQuery,
                {
                    statement: `message.ROWID in (${this.notSent.join(", ")})`,
                    args: null
                }
            ]
        });

        if (isNotEmpty(lookbackSent)) {
            Server().log(`Detected ${lookbackSent.length} sent (previously unsent) message(s)`, "debug");
        }

        // Fourth, add the new unsent items to the list
        const sentOrErrored = lookbackSent.filter(item => item.isSent || item.error > 0).map(item => item.ROWID);
        this.notSent = this.notSent.filter(item => !sentOrErrored.includes(item)); // Filter down not sent
        for (const i of unsent) // Add newly unsent to
            if (!this.notSent.includes(i)) this.notSent.push(i);

        // Emit the sent messages
        const entries = [...newSent, ...lookbackSent.filter(item => item.isSent)];
        for (const entry of entries) {
            const cacheName = getCacheName(entry);

            // Skip over any that we've finished
            if (this.cache.find(cacheName)) continue;

            // Add to cache
            this.cache.add(cacheName);

            // Resolve the promise for sent messages from a client
            Server().messageManager.resolve(entry);

            // Emit it as normal entry
            super.emit("new-entry", entry);
        }

        // Emit the errored messages
        const errored = lookbackSent.filter(item => item.error > 0);
        for (const entry of errored) {
            const cacheName = getCacheName(entry);

            // Skip over any that we've finished
            if (this.cache.find(cacheName)) continue;

            // Add to cache
            this.cache.add(cacheName);

            // Reject the corresponding promise.
            // This will emit a message send error
            const success = Server().messageManager.reject("message-send-error", entry);

            // Emit it as normal error
            if (!success) {
                super.emit("message-send-error", entry);
            }
        }
    }

    async emitUpdatedMessages(after: Date) {
        const baseQuery: DBWhereItem[] = [];

        // Get updated entries from myself only
        const entries = await this.repo.getUpdatedMessages({
            after,
            withChats: true,
            where: [
                ...baseQuery,
                {
                    statement: "message.is_from_me = :isFromMe",
                    args: { isFromMe: 1 }
                }
            ]
        });

        // Emit the new message
        for (const entry of entries) {
            // Compile so it's unique based on dates as well as ROWID
            const cacheName = `updated-${getCacheName(entry)}`;

            // Skip over any that we've finished
            if (this.cache.find(cacheName)) continue;

            // Add to cache
            this.cache.add(cacheName);

            // Resolve the promise
            Server().messageManager.resolve(entry);

            // Emit it as a normal update
            super.emit("updated-entry", entry);
        }
    }
}
