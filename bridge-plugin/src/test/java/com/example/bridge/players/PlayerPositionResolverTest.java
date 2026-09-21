package com.example.bridge.players;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.concurrent.atomic.AtomicReference;
import org.bukkit.Location;
import org.bukkit.NamespacedKey;
import org.bukkit.World;
import org.bukkit.entity.Player;
import org.junit.jupiter.api.Test;

final class PlayerPositionResolverTest {

    private static final Instant OBSERVED_AT = Instant.parse("2026-09-21T05:00:00Z");
    private static final Clock CLOCK = Clock.fixed(OBSERVED_AT, ZoneOffset.UTC);

    @Test
    void resolvesExactOnlinePlayerWithDimensionAndTimestamp() {
        World world = mock(World.class);
        when(world.getKey()).thenReturn(NamespacedKey.fromString("minecraft:overworld"));
        Player player = mock(Player.class);
        when(player.isOnline()).thenReturn(true);
        when(player.getLocation()).thenReturn(new Location(world, 12.5, 64.0, -3.25));
        AtomicReference<String> lookedUpName = new AtomicReference<>();

        PlayerPositionResolver resolver = new PlayerPositionResolver(
                name -> {
                    lookedUpName.set(name);
                    return player;
                },
                CLOCK);

        PlayerPositionResolver.Resolution result = resolver.resolve("PlayerOne");

        assertEquals(PlayerPositionResolver.Status.FOUND, result.status());
        assertEquals("PlayerOne", lookedUpName.get());
        assertTrue(result.snapshot() != null);
        assertEquals(12.5, result.snapshot().x());
        assertEquals(64.0, result.snapshot().y());
        assertEquals(-3.25, result.snapshot().z());
        assertEquals("minecraft:overworld", result.snapshot().dimension());
        assertEquals(OBSERVED_AT, result.snapshot().observedAt());
    }

    @Test
    void rejectsInvalidOrPartialNameBeforeCallingPaperLookup() {
        AtomicReference<String> lookedUpName = new AtomicReference<>();
        PlayerPositionResolver resolver = new PlayerPositionResolver(
                name -> {
                    lookedUpName.set(name);
                    return null;
                },
                CLOCK);

        assertThrows(IllegalArgumentException.class, () -> resolver.resolve("Player One"));
        assertThrows(IllegalArgumentException.class, () -> resolver.resolve(" PlayerOne"));
        assertNull(lookedUpName.get());
    }

    @Test
    void returnsNotFoundWhenExactPlayerIsOfflineOrMissing() {
        PlayerPositionResolver missing = new PlayerPositionResolver(name -> null, CLOCK);
        assertEquals(PlayerPositionResolver.Status.NOT_FOUND, missing.resolve("PlayerOne").status());

        Player offline = mock(Player.class);
        when(offline.isOnline()).thenReturn(false);
        PlayerPositionResolver offlineResolver = new PlayerPositionResolver(name -> offline, CLOCK);
        assertEquals(PlayerPositionResolver.Status.NOT_FOUND, offlineResolver.resolve("PlayerOne").status());
    }

    @Test
    void returnsPositionUnavailableForInvalidPaperLocation() {
        Player player = mock(Player.class);
        when(player.isOnline()).thenReturn(true);
        when(player.getLocation()).thenReturn(null);
        PlayerPositionResolver resolver = new PlayerPositionResolver(name -> player, CLOCK);

        assertEquals(
                PlayerPositionResolver.Status.POSITION_UNAVAILABLE,
                resolver.resolve("PlayerOne").status());
    }

    @Test
    void returnsPositionUnavailableWhenWorldIdentityIsMissing() {
        World world = mock(World.class);
        when(world.getKey()).thenReturn(null);
        Player player = mock(Player.class);
        when(player.isOnline()).thenReturn(true);
        when(player.getLocation()).thenReturn(new Location(world, 1, 2, 3));
        PlayerPositionResolver resolver = new PlayerPositionResolver(name -> player, CLOCK);

        assertEquals(
                PlayerPositionResolver.Status.POSITION_UNAVAILABLE,
                resolver.resolve("PlayerOne").status());
    }
}
