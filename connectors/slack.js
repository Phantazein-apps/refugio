import fetch from 'node-fetch';

export class SlackConnector {
  constructor(botToken, userToken) {
    this.botToken = botToken;
    this.userToken = userToken || botToken; // fallback to bot token if no user token provided
    this.baseUrl = 'https://slack.com/api';
  }

  async apiCall(endpoint, params = {}, { useUserToken = false } = {}) {
    const token = useUserToken ? this.userToken : this.botToken;
    const url = new URL(`${this.baseUrl}/${endpoint}`);
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        url.searchParams.append(key, value);
      }
    });

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    const data = await response.json();

    if (!data.ok) {
      throw new Error(`Slack API error: ${data.error}`);
    }

    return data;
  }

  async searchMessages(query, count = 20) {
    // search.messages REQUIRES a user token (xoxp-), not a bot token
    const data = await this.apiCall('search.messages', {
      query,
      count: Math.min(count, 100),
    }, { useUserToken: true });

    return {
      total: data.messages?.total || 0,
      matches: data.messages?.matches?.map((msg) => ({
        text: msg.text,
        user: msg.username,
        channel: msg.channel?.name,
        channel_id: msg.channel?.id,
        timestamp: msg.ts,
        permalink: msg.permalink,
        thread_ts: msg.thread_ts,
      })) || [],
    };
  }

  async getChannelHistory(channelId, limit = 50) {
    const data = await this.apiCall('conversations.history', {
      channel: channelId,
      limit: Math.min(limit, 100),
    });

    const userIds = [...new Set(data.messages?.map(m => m.user).filter(Boolean))];
    const users = {};
    
    for (const userId of userIds.slice(0, 20)) {
      try {
        const userInfo = await this.apiCall('users.info', { user: userId });
        users[userId] = userInfo.user?.real_name || userInfo.user?.name;
      } catch (e) {
        users[userId] = userId;
      }
    }

    return {
      messages: data.messages?.map((msg) => ({
        text: msg.text,
        user: users[msg.user] || msg.user,
        timestamp: msg.ts,
        thread_ts: msg.thread_ts,
        reply_count: msg.reply_count,
        reactions: msg.reactions?.map(r => ({ name: r.name, count: r.count })),
      })) || [],
    };
  }

  async listChannels(types = 'public_channel') {
    const data = await this.apiCall('conversations.list', {
      types,
      exclude_archived: true,
      limit: 200,
    });

    return {
      channels: data.channels?.map((ch) => ({
        id: ch.id,
        name: ch.name,
        is_private: ch.is_private,
        is_channel: ch.is_channel,
        is_group: ch.is_group,
        is_im: ch.is_im,
        num_members: ch.num_members,
        topic: ch.topic?.value,
        purpose: ch.purpose?.value,
      })) || [],
    };
  }

  async getThread(channelId, threadTs) {
    const data = await this.apiCall('conversations.replies', {
      channel: channelId,
      ts: threadTs,
    });

    const userIds = [...new Set(data.messages?.map(m => m.user).filter(Boolean))];
    const users = {};
    
    for (const userId of userIds) {
      try {
        const userInfo = await this.apiCall('users.info', { user: userId });
        users[userId] = userInfo.user?.real_name || userInfo.user?.name;
      } catch (e) {
        users[userId] = userId;
      }
    }

    return {
      thread: data.messages?.map((msg) => ({
        text: msg.text,
        user: users[msg.user] || msg.user,
        timestamp: msg.ts,
        is_parent: msg.ts === threadTs,
        reactions: msg.reactions?.map(r => ({ name: r.name, count: r.count })),
      })) || [],
    };
  }
}
