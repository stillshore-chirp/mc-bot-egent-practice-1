package com.example.bridge.http.handlers;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.example.bridge.events.BridgeEventHub;
import com.example.bridge.players.PlayerPositionResolver;
import com.example.bridge.util.AgentBridgeConfig;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.Headers;
import com.sun.net.httpserver.HttpExchange;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.concurrent.Callable;
import java.util.logging.Logger;
import org.junit.jupiter.api.Test;

final class PlayerPositionHandlerTest {

    private static final String API_KEY = "test-api-key";
    private final ObjectMapper mapper = new ObjectMapper().findAndRegisterModules();

    @Test
    void rejectsMissingApiKey() throws Exception {
        PlayerPositionHandler handler = handler(foundResolver());
        ByteArrayOutputStream output = new ByteArrayOutputStream();

        HttpExchange exchange = exchange("POST", null, "{\"player\":\"PlayerOne\"}", output);
        handler.handle(exchange);

        verify(exchange).sendResponseHeaders(401, output.size());
        assertEquals("unauthorized", json(output).path("error").asText());
    }

    @Test
    void rejectsWrongMethodWithoutQueryingPaper() throws Exception {
        PlayerPositionHandler handler = handler(foundResolver());
        ByteArrayOutputStream output = new ByteArrayOutputStream();

        HttpExchange exchange = exchange("GET", API_KEY, "{\"player\":\"PlayerOne\"}", output);
        handler.handle(exchange);

        verify(exchange).sendResponseHeaders(400, output.size());
        assertEquals("Invalid method; expected POST", json(output).path("error").asText());
    }

    @Test
    void rejectsBodyWithFieldsOtherThanPlayer() throws Exception {
        PlayerPositionHandler handler = handler(foundResolver());
        ByteArrayOutputStream output = new ByteArrayOutputStream();

        HttpExchange exchange = exchange(
                "POST", API_KEY, "{\"player\":\"PlayerOne\",\"dimension\":\"minecraft:overworld\"}", output);
        handler.handle(exchange);

        verify(exchange).sendResponseHeaders(400, output.size());
        assertEquals("request body must contain only player", json(output).path("error").asText());
    }

    @Test
    void rejectsOversizedBodyWithoutEchoingRequestContent() throws Exception {
        PlayerPositionHandler handler = handler(foundResolver());
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        String oversizedBody = "{\"player\":\"" + "x".repeat(300) + "\"}";

        HttpExchange exchange = exchange("POST", API_KEY, oversizedBody, output);
        handler.handle(exchange);

        verify(exchange).sendResponseHeaders(400, output.size());
        assertEquals("request body too large", json(output).path("error").asText());
    }

    @Test
    void rejectsMalformedBodyWithoutEchoingRequestContent() throws Exception {
        PlayerPositionHandler handler = handler(foundResolver());
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        String malformedBody = "{\"player\":\"PlayerOne\",\"detail\":";

        HttpExchange exchange = exchange("POST", API_KEY, malformedBody, output);
        handler.handle(exchange);

        verify(exchange).sendResponseHeaders(400, output.size());
        assertEquals("invalid request body", json(output).path("error").asText());
    }

    @Test
    void returnsPositionSnapshotWithoutEchoingPlayerName() throws Exception {
        PlayerPositionHandler handler = handler(foundResolver());
        ByteArrayOutputStream output = new ByteArrayOutputStream();

        HttpExchange exchange = exchange("POST", API_KEY, "{\"player\":\"PlayerOne\"}", output);
        handler.handle(exchange);

        verify(exchange).sendResponseHeaders(200, output.size());
        JsonNode response = json(output);
        assertEquals(true, response.path("ok").asBoolean());
        assertEquals(12.5, response.path("position").path("x").asDouble());
        assertEquals(64.0, response.path("position").path("y").asDouble());
        assertEquals(-3.25, response.path("position").path("z").asDouble());
        assertEquals("minecraft:overworld", response.path("dimension").asText());
        assertEquals("2026-09-21T05:00:00Z", response.path("observed_at").asText());
        assertEquals("", response.path("player").asText());
    }

    @Test
    void returnsFixed404ForMissingPlayer() throws Exception {
        PlayerPositionResolver resolver = new PlayerPositionResolver(name -> null, java.time.Clock.systemUTC());
        PlayerPositionHandler handler = handler(resolver);
        ByteArrayOutputStream output = new ByteArrayOutputStream();

        HttpExchange exchange = exchange("POST", API_KEY, "{\"player\":\"PlayerOne\"}", output);
        handler.handle(exchange);

        verify(exchange).sendResponseHeaders(404, output.size());
        assertEquals("player_not_found", json(output).path("error").asText());
    }

    @Test
    void returnsFixed503WhenPositionIsUnavailable() throws Exception {
        PlayerPositionResolver resolver = new PlayerPositionResolver(
                name -> {
                    throw new IllegalStateException("internal detail must not cross HTTP boundary");
                },
                java.time.Clock.systemUTC());
        PlayerPositionHandler handler = handler(resolver);
        ByteArrayOutputStream output = new ByteArrayOutputStream();

        HttpExchange exchange = exchange("POST", API_KEY, "{\"player\":\"PlayerOne\"}", output);
        handler.handle(exchange);

        verify(exchange).sendResponseHeaders(503, output.size());
        assertEquals("player_position_unavailable", json(output).path("error").asText());
    }

    private PlayerPositionHandler handler(PlayerPositionResolver resolver) {
        return new PlayerPositionHandler(
                null,
                config(),
                mapper,
                Logger.getLogger("player-position-test"),
                new BridgeEventHub(),
                resolver,
                new PlayerPositionHandler.SyncExecutor() {
                    @Override
                    public <T> T execute(Callable<T> task) throws Exception {
                        return task.call();
                    }
                });
    }

    private PlayerPositionResolver foundResolver() {
        return new PlayerPositionResolver(
                name -> {
                    org.bukkit.World world = mock(org.bukkit.World.class);
                    when(world.getKey())
                            .thenReturn(org.bukkit.NamespacedKey.fromString("minecraft:overworld"));
                    org.bukkit.entity.Player player = mock(org.bukkit.entity.Player.class);
                    when(player.isOnline()).thenReturn(true);
                    when(player.getLocation()).thenReturn(new org.bukkit.Location(world, 12.5, 64, -3.25));
                    return player;
                },
                java.time.Clock.fixed(Instant.parse("2026-09-21T05:00:00Z"), java.time.ZoneOffset.UTC));
    }

    private AgentBridgeConfig config() {
        org.bukkit.configuration.file.YamlConfiguration raw =
                new org.bukkit.configuration.file.YamlConfiguration();
        raw.set("api_key", API_KEY);
        return AgentBridgeConfig.from(raw);
    }

    private HttpExchange exchange(String method, String apiKey, String body, ByteArrayOutputStream output) {
        HttpExchange exchange = mock(HttpExchange.class);
        Headers requestHeaders = new Headers();
        if (apiKey != null) {
            requestHeaders.add("X-API-Key", apiKey);
        }
        when(exchange.getRequestHeaders()).thenReturn(requestHeaders);
        when(exchange.getRequestMethod()).thenReturn(method);
        when(exchange.getRequestBody())
                .thenReturn(new ByteArrayInputStream(body.getBytes(StandardCharsets.UTF_8)));
        when(exchange.getResponseHeaders()).thenReturn(new Headers());
        when(exchange.getResponseBody()).thenReturn(output);
        return exchange;
    }

    private JsonNode json(ByteArrayOutputStream output) throws Exception {
        JsonNode node = mapper.readTree(output.toByteArray());
        assertNotNull(node);
        return node;
    }
}
