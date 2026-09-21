package com.example.bridge.forestry;

import com.example.bridge.AgentBridgePlugin;
import com.example.bridge.util.WorldGuardFacade;
import org.bukkit.*;
import org.bukkit.block.*;
import org.bukkit.block.data.type.Leaves;
import org.bukkit.entity.Player;
import org.bukkit.event.block.*;
import org.junit.jupiter.api.*;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class ForestryGuardTest {
    World world;Player bot;WorldGuardFacade regions;ForestryGuard guard;NaturalWoodLedger ledger;
    Map<String,Block> blocks;
    @BeforeEach void setup() throws Exception {
        world=mock(World.class);when(world.getUID()).thenReturn(UUID.randomUUID());when(world.isChunkLoaded(anyInt(),anyInt())).thenReturn(true);
        blocks=new HashMap<>();when(world.getBlockAt(anyInt(),anyInt(),anyInt())).thenAnswer(i->block(i.getArgument(0),i.getArgument(1),i.getArgument(2)));
        bot=mock(Player.class);when(bot.getUniqueId()).thenReturn(UUID.randomUUID());when(bot.getWorld()).thenReturn(world);
        when(bot.getLocation()).thenReturn(new Location(world,.5,1,1.5));when(bot.getEyeLocation()).thenReturn(new Location(world,.5,2.6,1.5));
        regions=mock(WorldGuardFacade.class);when(regions.isUnclaimed(any(),any())).thenReturn(true);
        guard=new ForestryGuard(mock(AgentBridgePlugin.class),regions);
        var field=ForestryGuard.class.getDeclaredField("ledger");field.setAccessible(true);ledger=(NaturalWoodLedger)field.get(guard);
        Map<NaturalWoodLedger.Pos,String> logs=new HashMap<>();for(int y=1;y<=3;y++) logs.put(new NaturalWoodLedger.Pos(world.getUID(),0,y,0),"OAK_LOG");ledger.record(logs);
    }
    Block block(int x,int y,int z) {
        return blocks.computeIfAbsent(x+","+y+","+z,k->{
            Block b=mock(Block.class);when(b.getWorld()).thenReturn(world);when(b.getX()).thenReturn(x);when(b.getY()).thenReturn(y);when(b.getZ()).thenReturn(z);
            when(b.getLocation()).thenAnswer(i->new Location(world,x,y,z));
            when(b.getType()).thenReturn(y==0?Material.DIRT:x==0&&z==0&&y>=1&&y<=3?Material.OAK_LOG:Material.AIR);
            if(x==0&&z==0&&y==4) { Leaves leaves=mock(Leaves.class);when(b.getBlockData()).thenReturn(leaves);when(b.getType()).thenReturn(Material.OAK_LEAVES); }
            return b;
        });
    }
    @Test void verifiedGrowthAllowsTopFirstOnly() {
        assertTrue(guard.inspect(bot,block(0,1,0),false).allowed());
        assertFalse(guard.inspect(bot,block(0,1,0),true).allowed());
        assertTrue(guard.inspect(bot,block(0,3,0),true).allowed());
        var event=new BlockBreakEvent(block(0,3,0),bot);guard.breaking(event);assertFalse(event.isCancelled());
    }
    @Test void placementAfterPermitCancelsActualBreak() {
        assertTrue(guard.inspect(bot,block(0,3,0),true).allowed());
        var placed=mock(BlockPlaceEvent.class);when(placed.getBlock()).thenReturn(block(1,1,0));guard.placed(placed);
        var event=new BlockBreakEvent(block(0,3,0),bot);guard.breaking(event);assertTrue(event.isCancelled());
    }
    @Test void noPermitAndWrongBlockAreRejected() {
        guard.inspect(bot,block(0,3,0),true);
        var wrong=new BlockBreakEvent(block(0,2,0),bot);guard.breaking(wrong);assertTrue(wrong.isCancelled());
        var replay=new BlockBreakEvent(block(0,3,0),bot);guard.breaking(replay);assertTrue(replay.isCancelled());
    }
    @Test void protectionUnavailableIsNotPermission() throws Exception {
        when(regions.isUnclaimed(any(),any())).thenThrow(new IllegalStateException("unavailable"));
        assertFalse(guard.inspect(bot,block(0,3,0),true).allowed());
    }
    @Test void persistentLeavesAndUnobservedChunksRejectTree() {
        when(((Leaves)block(0,4,0).getBlockData()).isPersistent()).thenReturn(true);
        assertFalse(guard.inspect(bot,block(0,3,0),true).allowed());
        when(world.isChunkLoaded(anyInt(),anyInt())).thenReturn(false);assertFalse(guard.inspect(bot,block(0,3,0),true).allowed());
    }
    @Test void releaseDoesNotLeaveOtherMiningLocked() {
        guard.inspect(bot,block(0,3,0),true);guard.release(bot);
        var event=new BlockBreakEvent(block(2,1,0),bot);guard.breaking(event);assertFalse(event.isCancelled());
    }
}
