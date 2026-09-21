package com.example.bridge.forestry;

import java.util.*;

/** 成長イベントで確認した木だけを保持する。再起動後の履歴不明を許可へ変換しない。 */
public final class NaturalWoodLedger {
    public record Pos(UUID world, int x, int y, int z) {}
    public record Tree(Map<Pos, String> logs) {}
    private final Map<Pos, Tree> trees = new HashMap<>();
    public boolean record(Map<Pos, String> logs) {
        if (logs.size() < 3 || logs.size() > 6 || trees.size() + logs.size() > 20000) return false;
        Pos base = logs.keySet().stream().min(Comparator.comparingInt(Pos::y)).orElseThrow();
        if (logs.keySet().stream().anyMatch(p -> !p.world().equals(base.world()) || p.x() != base.x() || p.z() != base.z())) return false;
        for (int y = base.y(); y < base.y() + logs.size(); y++) if (!logs.containsKey(new Pos(base.world(), base.x(), y, base.z()))) return false;
        Tree tree = new Tree(Map.copyOf(logs));
        logs.keySet().forEach(p -> trees.put(p, tree));
        return true;
    }
    public Tree get(Pos p) { return trees.get(p); }
    public void invalidateNear(Pos p) {
        Set<Tree> invalid = new HashSet<>();
        trees.forEach((q, tree) -> { if (q.world().equals(p.world()) && Math.abs(q.x()-p.x()) <= 6 && Math.abs(q.y()-p.y()) <= 10 && Math.abs(q.z()-p.z()) <= 6) invalid.add(tree); });
        trees.entrySet().removeIf(e -> invalid.contains(e.getValue()));
    }
    public void remove(Pos p) { trees.remove(p); }
}
