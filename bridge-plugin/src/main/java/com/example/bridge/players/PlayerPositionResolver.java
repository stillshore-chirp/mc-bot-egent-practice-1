package com.example.bridge.players;

import java.time.Clock;
import java.time.Instant;
import java.util.Objects;
import java.util.regex.Pattern;
import org.bukkit.Bukkit;
import org.bukkit.Location;
import org.bukkit.NamespacedKey;
import org.bukkit.World;
import org.bukkit.entity.Player;

/**
 * Paper のオンラインプレイヤー位置を、HTTP 層から分離して解決するアダプター。
 *
 * <p>このクラスの {@link #resolve(String)} は Bukkit API を呼び出すため、呼び出し元は
 * Paper の main thread で実行しなければならない。HTTP handler は BaseHandler#callSync
 * を使ってその境界を作る。</p>
 */
public final class PlayerPositionResolver {

    private static final Pattern PLAYER_NAME_PATTERN = Pattern.compile("[A-Za-z0-9_]{3,16}");

    private final PlayerLookup playerLookup;
    private final Clock clock;

    /** 本番用コンストラクター。Bukkit の完全一致検索を利用する。 */
    public PlayerPositionResolver() {
        this(Bukkit::getPlayerExact, Clock.systemUTC());
    }

    /** テスト用にプレイヤー検索と時計を差し替えられるコンストラクター。 */
    public PlayerPositionResolver(PlayerLookup playerLookup, Clock clock) {
        this.playerLookup = Objects.requireNonNull(playerLookup, "playerLookup");
        this.clock = Objects.requireNonNull(clock, "clock");
    }

    /**
     * プレイヤー名を完全一致で解決し、Paper が保持する最新の位置スナップショットを返す。
     * 入力不正は呼び出し側へ返し、対象不在・位置不正・Paper API の一時的な例外は固定分類で返す。
     */
    public Resolution resolve(String rawPlayerName) {
        String playerName = normalizePlayerName(rawPlayerName);
        if (playerName == null) {
            throw new IllegalArgumentException("player must be an exact Minecraft username");
        }

        final Player player;
        try {
            player = playerLookup.findExact(playerName);
        } catch (RuntimeException ignored) {
            return Resolution.positionUnavailable();
        }
        if (player == null) {
            return Resolution.notFound();
        }

        try {
            if (!player.isOnline()) {
                return Resolution.notFound();
            }
            Location location = player.getLocation();
            if (location == null || location.getWorld() == null || !isFinite(location)) {
                return Resolution.positionUnavailable();
            }
            World world = location.getWorld();
            NamespacedKey worldKey = world.getKey();
            if (worldKey == null) {
                return Resolution.positionUnavailable();
            }
            Instant observedAt = clock.instant();
            if (observedAt == null) {
                return Resolution.positionUnavailable();
            }
            return Resolution.found(new Snapshot(
                    location.getX(),
                    location.getY(),
                    location.getZ(),
                    worldKey.asString(),
                    observedAt));
        } catch (RuntimeException ignored) {
            // HTTP 境界へ Paper の例外本文や内部情報を漏らさず、固定分類へ変換する。
            return Resolution.positionUnavailable();
        }
    }

    private static String normalizePlayerName(String rawPlayerName) {
        if (rawPlayerName == null) {
            return null;
        }
        String normalized = rawPlayerName.trim();
        if (!rawPlayerName.equals(normalized)) {
            return null;
        }
        return PLAYER_NAME_PATTERN.matcher(normalized).matches() ? normalized : null;
    }

    private static boolean isFinite(Location location) {
        return Double.isFinite(location.getX())
                && Double.isFinite(location.getY())
                && Double.isFinite(location.getZ());
    }

    @FunctionalInterface
    public interface PlayerLookup {
        Player findExact(String playerName);
    }

    public record Snapshot(double x, double y, double z, String dimension, Instant observedAt) {}

    public enum Status {
        FOUND,
        NOT_FOUND,
        POSITION_UNAVAILABLE
    }

    public record Resolution(Status status, Snapshot snapshot) {

        public static Resolution found(Snapshot snapshot) {
            return new Resolution(Status.FOUND, Objects.requireNonNull(snapshot, "snapshot"));
        }

        public static Resolution notFound() {
            return new Resolution(Status.NOT_FOUND, null);
        }

        public static Resolution positionUnavailable() {
            return new Resolution(Status.POSITION_UNAVAILABLE, null);
        }
    }
}
