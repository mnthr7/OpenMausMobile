// The fold. Everything here is a claim about what the user sees after a
// frame lands, so it is written against frames rather than internals.
import XCTest
@testable import CompanionCore

final class StoreTests: XCTestCase {
    func fleet() throws -> Fleet {
        let url = try XCTUnwrap(
            Bundle.module.url(forResource: "bots-paged", withExtension: "json", subdirectory: "Fixtures")
                ?? Bundle.module.url(forResource: "bots-paged", withExtension: "json")
        )
        return try JSONDecoder().decode(Fleet.self, from: try Data(contentsOf: url))
    }

    func message(_ id: String, at: Double = 1, text: String = "hello") -> Message {
        var message = Message(id: id, role: .user, kind: .text, at: at)
        message.text = text
        return message
    }

    func hydrated() throws -> CompanionState {
        var state = CompanionState()
        state.hydrate(try fleet())
        return state
    }

    // MARK: - Hydration

    func testHydrateIndexesEveryThread() throws {
        let state = try hydrated()
        XCTAssertFalse(state.bots.isEmpty)
        for bot in state.bots {
            XCTAssertNotNil(state.messages[bot.threadId])
        }
        for room in state.rooms {
            XCTAssertEqual(state.transcript(forThread: room.threadId).count, room.messages?.count)
            XCTAssertEqual(state.hasMore[room.threadId], room.hasMore)
        }
    }

    // MARK: - Messages

    func testAppendsAndPatchesInPlace() throws {
        var state = try hydrated()
        let threadId = try XCTUnwrap(state.bots.first).threadId
        let before = state.transcript(forThread: threadId).count

        state.apply(.message(threadId: threadId, message: message("new-1")))
        XCTAssertEqual(state.transcript(forThread: threadId).count, before + 1)

        var patched = message("new-1")
        patched.text = "edited"
        state.apply(.messagePatch(threadId: threadId, message: patched))
        XCTAssertEqual(state.transcript(forThread: threadId).count, before + 1, "a patch must not append")
        XCTAssertEqual(state.transcript(forThread: threadId).last?.text, "edited")
    }

    func testAReplayedMessageDoesNotAppearTwice() throws {
        // resuming redelivers whatever was in flight when the socket died
        var state = try hydrated()
        let threadId = try XCTUnwrap(state.bots.first).threadId
        let before = state.transcript(forThread: threadId).count

        state.apply(.message(threadId: threadId, message: message("dupe")))
        state.apply(.message(threadId: threadId, message: message("dupe")))
        XCTAssertEqual(state.transcript(forThread: threadId).count, before + 1)
    }

    func testScrollbackPrependsWithoutDuplicating() throws {
        var state = CompanionState()
        state.messages["t1"] = [message("c"), message("d")]
        state.prepend(ThreadPage(messages: [message("a"), message("b"), message("c")], hasMore: true), toThread: "t1")

        XCTAssertEqual(state.transcript(forThread: "t1").map(\.id), ["a", "b", "c", "d"])
        XCTAssertEqual(state.hasMore["t1"], true)
    }

    // MARK: - Bots

    func testABotFrameMergesRatherThanWipingTheTranscript() throws {
        // bot frames carry no messages; assigning one would empty the chat
        var state = try hydrated()
        var bot = try XCTUnwrap(state.bots.first)
        let threadId = bot.threadId
        state.apply(.message(threadId: threadId, message: message("keep-me")))
        let count = state.transcript(forThread: threadId).count

        bot.messages = nil
        bot.busy = true
        bot.unread = true
        state.apply(.bot(bot))

        XCTAssertEqual(state.bot(bot.id)?.busy, true)
        XCTAssertEqual(state.transcript(forThread: threadId).count, count)
        XCTAssertNotNil(state.bot(bot.id)?.messages, "the merged bot keeps the transcript it had")
    }

    func testDeletingABotTakesItsTranscriptWithIt() throws {
        var state = try hydrated()
        let bot = try XCTUnwrap(state.bots.first)
        state.apply(.botDeleted(botId: bot.id))

        XCTAssertNil(state.bot(bot.id))
        XCTAssertTrue(state.transcript(forThread: bot.threadId).isEmpty)
        XCTAssertNil(state.hasMore[bot.threadId])
    }

    func testAnUnknownBotFrameAddsIt() throws {
        var state = CompanionState()
        var bot = try XCTUnwrap(try hydrated().bots.first)
        bot.id = "brand-new"
        bot.threadId = "brand-new-thread"
        state.apply(.bot(bot))
        XCTAssertEqual(state.bots.count, 1)
        XCTAssertNotNil(state.messages["brand-new-thread"])
    }

    // MARK: - Approvals

    func testPendingApprovalsAreTheUnansweredOnesNewestFirst() {
        var state = CompanionState()
        func card(_ id: String, at: Double, requestId: String?, answered: String? = nil) -> Message {
            var message = Message(id: id, role: .bot, kind: .options, at: at)
            message.card = OptionCard(
                title: "Approval needed", subtitle: "rm -rf ./build", options: ["Allow", "Deny"],
                answered: answered, dismissed: nil, requestId: requestId, tool: "Bash",
                held: nil, allowKey: "Bash:rm"
            )
            return message
        }
        state.messages["t1"] = [
            card("old", at: 1, requestId: "r1"),
            card("answered", at: 2, requestId: "r2", answered: "Allow"),
            card("history", at: 3, requestId: nil),
        ]
        state.messages["t2"] = [card("new", at: 9, requestId: "r3")]

        let pending = state.pendingApprovals
        XCTAssertEqual(pending.map(\.message.id), ["new", "old"])
        XCTAssertEqual(pending.first?.threadId, "t2")
    }

    // MARK: - Cursor

    func testTheCursorFollowsTheStreamAndKeepsItsStreamId() {
        var state = CompanionState()
        state.apply(.hello(cursor: "abc12345:7", resumed: true))
        XCTAssertEqual(state.cursor, "abc12345:7")

        state.advance(to: 8)
        XCTAssertEqual(state.cursor, "abc12345:8", "the stream id is what stops a stale replay")

        // hello frames carry no seq, and nothing should move without one
        state.advance(to: nil)
        XCTAssertEqual(state.cursor, "abc12345:8")
    }

    func testAdvancingBeforeAnyHelloDoesNothing() {
        var state = CompanionState()
        state.advance(to: 4)
        XCTAssertNil(state.cursor, "without a stream id there is no cursor worth keeping")
    }

    // MARK: - Notifications

    func testNotificationsCollectInOrder() {
        var state = CompanionState()
        let approval = NotificationFrame(
            kind: "approval", botId: "b1", botName: "Scout", threadId: "t1",
            title: "Scout needs approval", body: "rm -rf"
        )
        let done = NotificationFrame(
            kind: "done", botId: "b1", botName: "Scout", threadId: "t1",
            title: "Scout finished", body: "pushed"
        )
        state.apply(.notify(approval))
        state.apply(.notify(done))

        XCTAssertEqual(state.notifications.count, 2)
        XCTAssertTrue(state.notifications[0].isBlocking)
        XCTAssertFalse(state.notifications[1].isBlocking)
    }

    // MARK: - Frames with nothing to fold

    func testFramesThisClientIgnoresAreHarmless() throws {
        var state = try hydrated()
        let before = state.bots.count
        state.apply(.screen(botId: "b1", png: "AAAA", mime: "image/png"))
        state.apply(.computer(botId: "b1", state: "provisioning"))
        state.apply(.config)
        state.apply(.runtime(RuntimeEvent(type: "content.delta", threadId: "t1", delta: "hi", streamKind: "assistant_text")))
        state.apply(.unknown(kind: "routine.run"))
        XCTAssertEqual(state.bots.count, before)
    }
}
