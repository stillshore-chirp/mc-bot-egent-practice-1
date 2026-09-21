package com.example.bridge.http.handlers;

import com.example.bridge.AgentBridgePlugin;
import com.example.bridge.events.BridgeEventHub;
import com.example.bridge.http.BaseHandler;
import com.example.bridge.util.AgentBridgeConfig;
import com.fasterxml.jackson.databind.*;
import com.sun.net.httpserver.HttpExchange;
import java.util.logging.Logger;
import org.bukkit.Bukkit;

/** 認証付き、上限付きの自然木判定。座標はBotと同じworldとして解釈する。 */
public final class ForestryHandler extends BaseHandler {
    private final AgentBridgePlugin plugin;
    public ForestryHandler(AgentBridgePlugin plugin, AgentBridgeConfig config, ObjectMapper mapper, Logger logger, BridgeEventHub events) {
        super(plugin,config,mapper,logger,events); this.plugin=plugin;
    }
    @Override protected void handleAuthed(HttpExchange exchange) throws Exception {
        ensureMethod(exchange,"POST");
        byte[] bytes=exchange.getRequestBody().readNBytes(513);
        if(bytes.length>512) throw new IllegalArgumentException("request too large");
        JsonNode root;
        try { root=mapper().readTree(bytes); } catch(Exception invalid) { throw new IllegalArgumentException("invalid forestry request"); }
        if(root==null || !root.isObject() || !root.path("bot").isTextual() || !root.path("bot").asText().matches("[A-Za-z0-9_]{3,16}")) throw new IllegalArgumentException("invalid forestry request");
        if(root.size()==2 && root.path("release").isBoolean() && root.path("release").asBoolean()) {
            String name=root.get("bot").asText();
            callSync(() -> { var bot=Bukkit.getPlayerExact(name);if(bot!=null) plugin.forestry().release(bot);return true; });
            var response=mapper().createObjectNode();response.put("released",true);sendJson(exchange,200,response);return;
        }
        if(root.size()!=5 || !root.path("grant").isBoolean()) throw new IllegalArgumentException("invalid forestry request");
        for(String axis:new String[]{"x","y","z"}) if(!root.path(axis).isIntegralNumber() || !root.path(axis).canConvertToInt() || Math.abs(root.path(axis).asLong())>30000000) throw new IllegalArgumentException("invalid forestry position");
        final JsonNode request=root;
        var check=callSync(() -> {
            var bot=Bukkit.getPlayerExact(request.get("bot").asText());
            if(bot==null || !bot.isOnline()) throw new IllegalArgumentException("bot unavailable");
            int x=request.get("x").asInt(), y=request.get("y").asInt(), z=request.get("z").asInt();
            if(!bot.getWorld().isChunkLoaded(x>>4,z>>4) || y<bot.getWorld().getMinHeight() || y>=bot.getWorld().getMaxHeight()) throw new IllegalArgumentException("observation unavailable");
            return plugin.forestry().inspect(bot,bot.getWorld().getBlockAt(x,y,z),request.get("grant").asBoolean());
        });
        var result=mapper().createObjectNode(); result.put("allowed",check.allowed()); result.put("reason",check.reason());
        var logs=result.putArray("logs");
        for(var p:check.logs()) { var item=logs.addObject();item.put("x",p.getBlockX());item.put("y",p.getBlockY());item.put("z",p.getBlockZ()); }
        sendJson(exchange,200,result);
    }
}
