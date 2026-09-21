package com.example.bridge.forestry;

import com.example.bridge.AgentBridgePlugin;
import com.example.bridge.util.WorldGuardFacade;
import com.sk89q.worldedit.math.BlockVector3;
import java.util.*;
import org.bukkit.*;
import org.bukkit.block.Block;
import org.bukkit.block.BlockState;
import org.bukkit.block.data.type.Leaves;
import org.bukkit.entity.Player;
import org.bukkit.event.*;
import org.bukkit.event.block.*;
import org.bukkit.event.entity.EntityExplodeEvent;
import org.bukkit.event.world.StructureGrowEvent;
import org.bukkit.event.player.PlayerQuitEvent;

/** Paper main threadで判定し、実際の破壊イベントでも再確認する自然木の安全境界。 */
public final class ForestryGuard implements Listener {
    private final NaturalWoodLedger ledger = new NaturalWoodLedger();
    private final WorldGuardFacade regions;
    private final AgentBridgePlugin plugin;
    private final Set<UUID> guardedBots = new HashSet<>();
    private final Map<UUID, Permit> permits = new HashMap<>();
    private long mutationVersion;
    private record Permit(NaturalWoodLedger.Pos pos, long expires) {}
    public record Check(boolean allowed, String reason, List<BlockVector3> logs) {}
    private static final Set<String> GROUND = Set.of("DIRT", "GRASS_BLOCK", "PODZOL", "COARSE_DIRT", "ROOTED_DIRT", "MOSS_BLOCK");
    private static final Set<String> SOFT = Set.of("AIR", "CAVE_AIR", "VOID_AIR", "SHORT_GRASS", "TALL_GRASS", "FERN", "LARGE_FERN", "VINE", "SNOW");
    public ForestryGuard(AgentBridgePlugin plugin, WorldGuardFacade regions) { this.plugin=plugin; this.regions=regions; }
    public void release(Player bot) { permits.remove(bot.getUniqueId()); guardedBots.remove(bot.getUniqueId()); }
    @EventHandler public void disconnected(PlayerQuitEvent event) { release(event.getPlayer()); }
    private static boolean log(Material type) { return Set.of(Material.OAK_LOG, Material.BIRCH_LOG, Material.SPRUCE_LOG).contains(type); }
    private static NaturalWoodLedger.Pos pos(Block b) { return new NaturalWoodLedger.Pos(b.getWorld().getUID(), b.getX(), b.getY(), b.getZ()); }
    @EventHandler(priority=EventPriority.MONITOR, ignoreCancelled=true)
    public void grown(StructureGrowEvent event) {
        long version=mutationVersion;
        Map<NaturalWoodLedger.Pos,String> logs = new HashMap<>();
        for (BlockState b : event.getBlocks()) if (log(b.getType())) logs.put(pos(b.getBlock()), b.getType().name());
        // MONITOR時点ではまだ適用前。次tickで実ブロックと照合し、cancelや変更を許可根拠にしない。
        plugin.getServer().getScheduler().runTask(plugin, () -> {
            if (event.isCancelled() || version!=mutationVersion) return;
            for (var e : logs.entrySet()) { var p=e.getKey(); if (!event.getWorld().isChunkLoaded(p.x()>>4,p.z()>>4) || !event.getWorld().getBlockAt(p.x(),p.y(),p.z()).getType().name().equals(e.getValue())) return; }
            ledger.record(logs);
        });
    }
    @EventHandler(priority=EventPriority.MONITOR, ignoreCancelled=true)
    public void placed(BlockPlaceEvent e) { mutationVersion++;ledger.invalidateNear(pos(e.getBlock())); }
    @EventHandler(priority=EventPriority.MONITOR, ignoreCancelled=true)
    public void extend(BlockPistonExtendEvent e) { mutationVersion++;e.getBlocks().forEach(b -> { ledger.invalidateNear(pos(b)); ledger.invalidateNear(pos(b.getRelative(e.getDirection()))); }); }
    @EventHandler(priority=EventPriority.MONITOR, ignoreCancelled=true)
    public void retract(BlockPistonRetractEvent e) { mutationVersion++;e.getBlocks().forEach(b -> { ledger.invalidateNear(pos(b)); ledger.invalidateNear(pos(b.getRelative(e.getDirection()))); }); }
    @EventHandler(priority=EventPriority.MONITOR, ignoreCancelled=true)
    public void explode(EntityExplodeEvent e) { mutationVersion++;e.blockList().forEach(b -> ledger.invalidateNear(pos(b))); }
    @EventHandler(priority=EventPriority.MONITOR, ignoreCancelled=true)
    public void blockExplode(BlockExplodeEvent e) { mutationVersion++;e.blockList().forEach(b -> ledger.invalidateNear(pos(b))); }
    @EventHandler(priority=EventPriority.HIGHEST, ignoreCancelled=true)
    public void breaking(BlockBreakEvent e) {
        if (!guardedBots.contains(e.getPlayer().getUniqueId())) return;
        Permit permit=permits.remove(e.getPlayer().getUniqueId());
        if (permit==null || permit.expires()<System.currentTimeMillis() || !permit.pos().equals(pos(e.getBlock())) || !inspect(e.getPlayer(),e.getBlock(),false).allowed()) e.setCancelled(true);
    }
    @EventHandler(priority=EventPriority.MONITOR, ignoreCancelled=true)
    public void broken(BlockBreakEvent e) {
        mutationVersion++;
        if (guardedBots.contains(e.getPlayer().getUniqueId())) ledger.remove(pos(e.getBlock()));
        else ledger.invalidateNear(pos(e.getBlock()));
    }
    public Check inspect(Player bot, Block block, boolean grant) {
        if (grant) guardedBots.add(bot.getUniqueId());
        if (bot.getWorld()!=block.getWorld() || bot.getLocation().distanceSquared(block.getLocation())>24*24) return denied("out_of_range");
        var tree=ledger.get(pos(block));
        if (tree==null) return denied("origin_unknown");
        var base=tree.logs().keySet().stream().min(Comparator.comparingInt(NaturalWoodLedger.Pos::y)).orElseThrow();
        World world=block.getWorld();
        if (!GROUND.contains(world.getBlockAt(base.x(),base.y()-1,base.z()).getType().name())) return denied("unnatural_ground");
        List<BlockVector3> remaining=new ArrayList<>();
        int top=base.y()+tree.logs().size()-1;
        boolean leaves=false;
        try {
            // 人工材、未確認の原木、persistent葉、保護region、未ロードがあれば全木を拒否。
            for (int x=base.x()-2;x<=base.x()+2;x++) for(int z=base.z()-2;z<=base.z()+2;z++) for(int y=base.y();y<=top+2;y++) {
                if(!world.isChunkLoaded(x>>4,z>>4)) return denied("observation_unknown");
                Block b=world.getBlockAt(x,y,z); var p=pos(b);
                if(!regions.isUnclaimed(world,BlockVector3.at(x,y,z))) return denied("protected_or_unknown");
                String expected=tree.logs().get(p);
                if(expected!=null && ledger.get(p)==tree) {
                    if(!b.getType().name().equals(expected)) return denied("world_changed");
                    remaining.add(BlockVector3.at(x,y,z)); continue;
                }
                if(b.getBlockData() instanceof Leaves leaf) { if(leaf.isPersistent()) return denied("building_suspected"); leaves=true; continue; }
                if(!SOFT.contains(b.getType().name()) && !Tag.FLOWERS.isTagged(b.getType())) return denied("building_suspected");
            }
        } catch(Exception | LinkageError unavailable) { return denied("protected_or_unknown"); }
        if(!leaves || remaining.isEmpty()) return denied("tree_shape_unknown");
        remaining.sort(Comparator.comparingInt(BlockVector3::getBlockY).reversed());
        if(grant) {
            if(!remaining.get(0).equals(BlockVector3.at(block.getX(),block.getY(),block.getZ())) || bot.getEyeLocation().distanceSquared(block.getLocation().add(.5,.5,.5))>4.5*4.5) return denied("reach_or_order");
            permits.put(bot.getUniqueId(),new Permit(pos(block),System.currentTimeMillis()+10000));
        }
        return new Check(true,"natural_growth_verified",remaining);
    }
    private static Check denied(String reason) { return new Check(false,reason,List.of()); }
}
