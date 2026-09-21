package com.example.bridge.http.handlers;

import com.example.bridge.AgentBridgePlugin;
import com.example.bridge.events.BridgeEventHub;
import com.example.bridge.http.BaseHandler;
import com.example.bridge.players.PlayerPositionResolver;
import com.example.bridge.util.AgentBridgeConfig;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sun.net.httpserver.HttpExchange;
import java.io.IOException;
import java.io.InputStream;
import java.util.concurrent.Callable;
import java.util.logging.Logger;

/** 認証済みの呼び出し元へ、オンラインプレイヤーの現在位置を返すHTTPハンドラ。 */
public final class PlayerPositionHandler extends BaseHandler {

    private static final int MAX_REQUEST_BYTES = 256;

    private final PlayerPositionResolver resolver;
    private final SyncExecutor syncExecutor;

    public PlayerPositionHandler(
            AgentBridgePlugin plugin,
            AgentBridgeConfig config,
            ObjectMapper mapper,
            Logger logger,
            BridgeEventHub eventHub,
            PlayerPositionResolver resolver) {
        this(plugin, config, mapper, logger, eventHub, resolver, null);
    }

    /** テストでPaper scheduler境界を差し替えるためのコンストラクター。 */
    PlayerPositionHandler(
            AgentBridgePlugin plugin,
            AgentBridgeConfig config,
            ObjectMapper mapper,
            Logger logger,
            BridgeEventHub eventHub,
            PlayerPositionResolver resolver,
            SyncExecutor syncExecutor) {
        super(plugin, config, mapper, logger, eventHub);
        this.resolver = resolver;
        this.syncExecutor = syncExecutor;
    }

    @Override
    protected <T> T callSync(Callable<T> task) throws Exception {
        return syncExecutor == null ? super.callSync(task) : syncExecutor.execute(task);
    }

    @Override
    protected void handleAuthed(HttpExchange exchange) throws Exception {
        ensureMethod(exchange, "POST");
        JsonNode root = parseRequestBody(exchange);
        String playerName = parsePlayerName(root);
        PlayerPositionResolver.Resolution resolution = callSync(() -> resolver.resolve(playerName));

        if (resolution.status() == PlayerPositionResolver.Status.NOT_FOUND) {
            sendError(exchange, 404, "player_not_found");
            return;
        }
        if (resolution.status() == PlayerPositionResolver.Status.POSITION_UNAVAILABLE) {
            sendError(exchange, 503, "player_position_unavailable");
            return;
        }

        PlayerPositionResolver.Snapshot snapshot = resolution.snapshot();
        if (snapshot == null) {
            sendError(exchange, 503, "player_position_unavailable");
            return;
        }

        ObjectNode response = mapper().createObjectNode();
        response.put("ok", true);
        ObjectNode position = response.putObject("position");
        position.put("x", snapshot.x());
        position.put("y", snapshot.y());
        position.put("z", snapshot.z());
        response.put("dimension", snapshot.dimension());
        response.put("observed_at", snapshot.observedAt().toString());
        sendJson(exchange, 200, response);
    }

    private String parsePlayerName(JsonNode root) {
        if (root == null || !root.isObject() || root.size() != 1) {
            throw new IllegalArgumentException("request body must contain only player");
        }
        JsonNode playerNode = root.get("player");
        if (playerNode == null || !playerNode.isTextual()) {
            throw new IllegalArgumentException("player must be a string");
        }
        String rawPlayerName = playerNode.asText();
        if (rawPlayerName.isEmpty() || !rawPlayerName.equals(rawPlayerName.trim())) {
            throw new IllegalArgumentException("player must be an exact Minecraft username");
        }
        return rawPlayerName;
    }

    private JsonNode parseRequestBody(HttpExchange exchange) throws IOException {
        try (InputStream body = exchange.getRequestBody()) {
            byte[] bytes = body.readNBytes(MAX_REQUEST_BYTES + 1);
            if (bytes.length > MAX_REQUEST_BYTES) {
                throw new IllegalArgumentException("request body too large");
            }
            if (bytes.length == 0) {
                return null;
            }
            try {
                return mapper().readTree(bytes);
            } catch (JsonProcessingException ignored) {
                // BaseHandler の汎用 JSON 例外ログへ、リクエスト由来の本文を渡さない。
                throw new IllegalArgumentException("invalid request body");
            }
        }
    }

    private void sendError(HttpExchange exchange, int status, String error) throws IOException {
        ObjectNode response = mapper().createObjectNode();
        response.put("error", error);
        sendJson(exchange, status, response);
    }

    @FunctionalInterface
    interface SyncExecutor {
        <T> T execute(Callable<T> task) throws Exception;
    }
}
