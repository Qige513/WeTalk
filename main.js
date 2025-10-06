// main.js - 使用 MQTT 实现的 WeTalk

$(document).ready(function() {
    let client; // MQTT 客户端
    let nickname = '';
    let roomKey = '';
    let avatar = '';
    let users = {};
    let typingUsers = new Set();
    let messageIds = new Set(); // 用于去重消息的 ID
    let zoomLevel = 1; // 图片缩放级别
    let isDragging = false;
    let startX, startY, initialX, initialY;

    // 获取随机头像
    function getRandomAvatar() {
        return $.getJSON('https://v2.xxapi.cn/api/head').then(function(data) {
            if (data.code === 200) {
                return data.data;
            } else {
                return 'https://via.placeholder.com/32?text=👤';
            }
        }).fail(function() {
            return 'https://via.placeholder.com/32?text=👤';
        });
    }

    // 加入 WeTalk
    $('#join').click(function() {
        nickname = $('#nickname').val().trim();
        roomKey = $('#key').val().trim();
        if (nickname && roomKey) {
            getRandomAvatar().then(function(avatarUrl) {
                avatar = avatarUrl;
                connectMQTT();
                $('#login').hide();
                $('#chat').show();
                $('#login-status').text('');
                users[nickname] = avatar;
                broadcastUserList();
                updateOnlineUsers();
            });
        } else {
            $('#login-status').text('请填写昵称和密钥');
        }
    });

    // 自动填充room参数
    const urlParams = new URLSearchParams(window.location.search);
    const room = urlParams.get('room');
    if (room) {
        const decodedRoom = decodeURIComponent(room);
        $('#key').val(decodedRoom);
        roomKey = decodedRoom;
    }

    // 分享 WeTalk
    $('#share-room').click(function() {
        if (!roomKey) {
            alert('请先加入 WeTalk');
            return;
        }
        const shareUrl = `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(roomKey)}`;
        console.log('分享URL:', shareUrl);
        if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(shareUrl).then(() => {
                alert('分享链接已复制到剪贴板: ' + shareUrl);
            }).catch(() => {
                const copied = prompt('复制失败，请手动复制此链接:', shareUrl);
                if (copied) alert('链接已复制!');
            });
        } else {
            const textArea = document.createElement('textarea');
            textArea.value = shareUrl;
            document.body.appendChild(textArea);
            textArea.select();
            try {
                document.execCommand('copy');
                alert('分享链接已复制到剪贴板: ' + shareUrl);
            } catch (err) {
                const copied = prompt('复制失败，请手动复制此链接:', shareUrl);
                if (copied) alert('链接已复制!');
            }
            document.body.removeChild(textArea);
        }
    });

    // 发送消息
    $('#send').click(sendMessage);
    $('#message-input').on('keydown', function(e) {
        if (e.ctrlKey && e.key === 'Enter') sendMessage();
        else if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });

    function sendMessage() {
        const content = $('#message-input').val().trim();
        if (content && client && client.connected) {
            const encrypted = encrypt(content, roomKey);
            const messageId = Date.now() + '_' + Math.random().toString(36).substr(2, 9); // 改进 ID 生成，避免重复
            const messageData = {
                type: 'message',
                content: encrypted,
                nickname: nickname,
                avatar: avatar,
                timestamp: Date.now(),
                id: messageId
            };
            if (!messageIds.has(messageId)) {
                messageIds.add(messageId);
                client.publish(`/chat/${roomKey}`, JSON.stringify(messageData), { qos: 1 });
                addMessage(content, nickname, true, avatar);
                $('#message-input').val('');
            }
        }
    }

    // 连接 MQTT
    function connectMQTT() {
        client = mqtt.connect('wss://broker.emqx.io:8084/mqtt', {
            username: roomKey,
            clientId: `client_${nickname}_${Date.now()}`,
            protocolVersion: 4,
            reconnectPeriod: 1000
        });

        client.on('connect', () => {
            console.log('MQTT 连接成功');
            client.subscribe(`/chat/${roomKey}`, { qos: 1 });
            const joinData = { type: 'join', nickname, avatar, timestamp: Date.now() };
            client.publish(`/chat/${roomKey}`, JSON.stringify(joinData), { qos: 1 });
            addSystemMessage('已连接到 WeTalk');
            broadcastUserList();
        });

        client.on('message', (topic, message) => {
            try {
                const data = JSON.parse(message.toString());
                if (topic === `/chat/${roomKey}`) {
                    if (data.type === 'message' && data.nickname !== nickname && data.id && !messageIds.has(data.id)) {
                        messageIds.add(data.id);
                        const decrypted = decrypt(data.content, roomKey);
                        addMessage(decrypted, data.nickname, false, data.avatar || avatar);
                    } else if (data.type === 'join' && data.nickname !== nickname) {
                        users[data.nickname] = data.avatar || avatar;
                        updateOnlineUsers();
                        addSystemMessage(`${data.nickname} 加入了 WeTalk`);
                        broadcastUserList();
                    } else if (data.type === 'leave' && data.nickname !== nickname) {
                        if (users[data.nickname]) {
                            delete users[data.nickname];
                            updateOnlineUsers();
                            addSystemMessage(`${data.nickname} 离开了 WeTalk`);
                            broadcastUserList();
                        }
                    } else if (data.type === 'typing') {
                        if (data.isTyping && data.nickname !== nickname) typingUsers.add(data.nickname);
                        else if (!data.isTyping && data.nickname !== nickname) typingUsers.delete(data.nickname);
                        updateTypingIndicator();
                    } else if (data.type === 'image' && data.nickname !== nickname && data.id && !messageIds.has(data.id)) {
                        messageIds.add(data.id);
                        addImageMessage(data.url, data.nickname, false, data.avatar || avatar);
                    } else if (data.type === 'userlist') {
                        users = data.users.reduce((acc, user) => (acc[user.nickname] = user.avatar || avatar, acc), {});
                        updateOnlineUsers();
                    }
                }
            } catch (err) {
                console.error('解析消息错误:', err);
            }
        });

        client.on('close', () => {
            addSystemMessage('连接断开，正在重连...');
            reconnectMQTT();
        });

        client.on('error', (err) => {
            console.error('MQTT 错误:', err);
            addSystemMessage('连接失败，请检查网络或密钥');
        });

        $(window).on('beforeunload', function() {
            if (client && client.connected) {
                const leaveData = { type: 'leave', nickname, timestamp: Date.now() };
                client.publish(`/chat/${roomKey}`, JSON.stringify(leaveData), { qos: 1 });
            }
        });
    }

    // 重连逻辑
    function reconnectMQTT() {
        if (nickname && roomKey && !client.connected) {
            client = mqtt.connect('wss://broker.emqx.io:8084/mqtt', {
                username: roomKey,
                clientId: `client_${nickname}_${Date.now()}`,
                protocolVersion: 4,
                reconnectPeriod: 1000
            });
            client.on('connect', () => {
                console.log('MQTT 重连成功');
                client.subscribe(`/chat/${roomKey}`, { qos: 1 });
                const joinData = { type: 'join', nickname, avatar, timestamp: Date.now() };
                client.publish(`/chat/${roomKey}`, JSON.stringify(joinData), { qos: 1 });
                addSystemMessage('已重新连接到 WeTalk');
                broadcastUserList();
            });
        }
    }

    // 广播用户列表
    function broadcastUserList() {
        if (client && client.connected) {
            const userList = { type: 'userlist', users: Object.keys(users).map(n => ({ nickname: n, avatar: users[n] })) };
            client.publish(`/chat/${roomKey}`, JSON.stringify(userList), { qos: 1 });
        }
    }

    // 端到端加密
    function encrypt(text, key) {
        try {
            return CryptoJS.AES.encrypt(text, key).toString();
        } catch (err) {
            console.error('加密失败:', err);
            return text;
        }
    }

    function decrypt(ciphertext, key) {
        try {
            const bytes = CryptoJS.AES.decrypt(ciphertext, key);
            return bytes.toString(CryptoJS.enc.Utf8) || ciphertext;
        } catch (err) {
            console.error('解密失败:', err);
            return ciphertext;
        }
    }

    // 添加消息
    function addMessage(content, nick, isSent, senderAvatar) {
        const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const direction = isSent ? 'sent' : 'received';
        const html = `
            <div class="message ${direction}">
                <div class="avatar-container">
                    <span class="nickname">${escapeHtml(nick)}</span>
                    <img src="${senderAvatar || 'https://via.placeholder.com/32?text=👤'}" alt="${nick}" class="avatar">
                </div>
                <div class="content">${escapeHtml(content)}</div>
                <div class="time">${time}</div>
            </div>
        `;
        $('#messages').append(html);
        $('#messages').scrollTop($('#messages')[0].scrollHeight);
    }

    // 添加图片消息
    function addImageMessage(url, nick, isSent, senderAvatar) {
        const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const direction = isSent ? 'sent' : 'received';
        const html = `
            <div class="message ${direction}">
                <div class="avatar-container">
                    <span class="nickname">${escapeHtml(nick)}</span>
                    <img src="${senderAvatar || 'https://via.placeholder.com/32?text=👤'}" alt="${nick}" class="avatar">
                </div>
                <img class="image-content" src="${url}" alt="图像" onclick="viewImage('${url}')">
                <div class="time">${time}</div>
            </div>
        `;
        $('#messages').append(html);
        $('#messages').scrollTop($('#messages')[0].scrollHeight);
    }

    // 添加系统消息
    function addSystemMessage(content) {
        const html = `<div class="system-message">${escapeHtml(content)}</div>`;
        $('#messages').append(html);
        $('#messages').scrollTop($('#messages')[0].scrollHeight);
    }

    // 更新在线用户
    function updateOnlineUsers() {
        $('#user-list').empty();
        if (Object.keys(users).length === 0) {
            $('#user-list').html('<div class="no-users">暂无其他用户</div>');
        } else {
            Object.entries(users).forEach(([user, userAvatar]) => {
                const html = `
                    <div class="online-user">
                        <img src="${userAvatar || 'https://via.placeholder.com/24?text=👤'}" alt="${user}" class="avatar-small">
                        ${escapeHtml(user)}
                    </div>
                `;
                $('#user-list').append(html);
            });
        }
    }

    // 打字指示器
    function updateTypingIndicator() {
        if (typingUsers.size > 0) {
            const typingText = Array.from(typingUsers).slice(0, 2).join(', ') + (typingUsers.size > 2 ? ' 等' : '') + ' 正在输入...';
            $('.typing-indicator').text(typingText).show();
        } else {
            $('.typing-indicator').hide();
        }
    }

    // 在线用户面板
    $('.online-users-toggle').click(function() {
        console.log('点击在线用户按钮');
        $('#online-users').toggle();
        updateOnlineUsers();
    });

    $('.close-panel').click(function() {
        $('#online-users').hide();
    });

    // 图片上传
    $('#image-upload').change(function() {
        const file = this.files[0];
        if (file) {
            const quality = 0.99;
            const toWebP = $('#convert-webp').is(':checked');
            const reader = new FileReader();
            reader.onload = function(e) {
                const img = new Image();
                img.src = e.target.result;
                img.onload = function() {
                    const canvas = document.createElement('canvas');
                    const maxWidth = 800;
                    const maxHeight = 600;
                    let { width, height } = img;
                    if (width > maxWidth || height > maxHeight) {
                        const ratio = Math.min(maxWidth / width, maxHeight / height);
                        width *= ratio;
                        height *= ratio;
                    }
                    canvas.width = width;
                    canvas.height = height;
                    canvas.getContext('2d').drawImage(img, 0, 0, width, height);
                    let url;
                    if (toWebP && canvas.toDataURL('image/webp').startsWith('data:image/webp')) {
                        url = canvas.toDataURL('image/webp', quality);
                    } else {
                        url = canvas.toDataURL('image/jpeg', quality);
                    }
                    const messageId = Date.now() + '_' + Math.random().toString(36).substr(2, 9); // 改进 ID 生成
                    if (!messageIds.has(messageId)) {
                        messageIds.add(messageId);
                        addImageMessage(url, nickname, true, avatar);
                        if (client && client.connected) {
                            client.publish(`/chat/${roomKey}`, JSON.stringify({
                                type: 'image',
                                url: url,
                                nickname: nickname,
                                avatar: avatar,
                                timestamp: Date.now(),
                                id: messageId
                            }), { qos: 1 });
                        }
                    }
                    $('#image-preview-container').hide();
                };
            };
            reader.readAsDataURL(file);
            reader.onloadend = function() {
                $('#image-preview').attr('src', reader.result);
                $('#image-preview-container').show();
            };
        }
    });

    // 移除预览
    $('#remove-image').click(function() {
        $('#image-upload').val('');
        $('#image-preview-container').hide();
    });

    // 图片查看和拖动
    window.viewImage = function(url) {
        const img = $('#viewer-image');
        img.attr('src', url).data('zoom', 1).css({
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%) scale(1)'
        });
        $('#image-viewer').show();
        zoomLevel = 1;
        updateZoom();
        isDragging = false;
        startX = startY = initialX = initialY = 0;
    };

    $('.zoom-in').click(function() {
        zoomLevel += 0.2;
        updateZoom();
    });

    $('.zoom-out').click(function() {
        zoomLevel = Math.max(0.2, zoomLevel - 0.2);
        updateZoom();
    });

    $('.download').click(function() {
        const link = document.createElement('a');
        link.href = $('#viewer-image').attr('src');
        link.download = `image_${Date.now()}.png`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    });

    $('#image-viewer-close').click(function() {
        $('#image-viewer').hide();
        zoomLevel = 1;
        updateZoom();
    });

    // 拖动功能优化
    $('.draggable').on('mousedown touchstart', function(e) {
        isDragging = true;
        const touch = e.type === 'touchstart' ? e.originalEvent.touches[0] : e;
        startX = touch.pageX;
        startY = touch.pageY;
        const img = $(this);
        const offset = img.position();
        initialX = offset.left;
        initialY = offset.top;
        img.css('cursor', 'grabbing');
    });

    $(document).on('mousemove touchmove', function(e) {
        if (isDragging) {
            const touch = e.type === 'touchmove' ? e.originalEvent.touches[0] : e;
            const dx = touch.pageX - startX;
            const dy = touch.pageY - startY;
            const img = $('.draggable');
            const newLeft = initialX + dx;
            const newTop = initialY + dy;
            // 边界检查，防止拖出屏幕
            const viewWidth = $(window).width();
            const viewHeight = $(window).height();
            const imgWidth = img.width() * zoomLevel;
            const imgHeight = img.height() * zoomLevel;
            const boundedLeft = Math.max(0, Math.min(newLeft, viewWidth - imgWidth));
            const boundedTop = Math.max(0, Math.min(newTop, viewHeight - imgHeight));
            img.css({
                left: boundedLeft,
                top: boundedTop
            });
        }
    });

    $(document).on('mouseup touchend', function() {
        if (isDragging) {
            isDragging = false;
            $('.draggable').css('cursor', 'move');
        }
    });

    function updateZoom() {
        const img = $('.draggable');
        img.css('transform', `translate(-50%, -50%) scale(${zoomLevel})`);
    }

    // 移动端返回主页
    $('.back-arrow').click(function() {
        if (window.innerWidth <= 768 && client && client.connected) {
            const leaveData = { type: 'leave', nickname, timestamp: Date.now() };
            client.publish(`/chat/${roomKey}`, JSON.stringify(leaveData), { qos: 1 });
            client.end(); // 断开连接
            $('#chat').hide();
            $('#login').show();
            $('#message-input').val('');
            users = {};
            messageIds.clear();
            typingUsers.clear();
            $('#messages').empty();
            reconnectMQTT();
        }
    });

    // 打字事件
    let typingTimer;
    $('#message-input').on('input', function() {
        clearTimeout(typingTimer);
        if (client && client.connected) {
            client.publish(`/chat/${roomKey}`, JSON.stringify({ type: 'typing', isTyping: true, nickname }), { qos: 1 });
            typingTimer = setTimeout(() => {
                client.publish(`/chat/${roomKey}`, JSON.stringify({ type: 'typing', isTyping: false, nickname }), { qos: 1 });
            }, 2000);
        }
    });

    // 防止XSS攻击的HTML转义
    function escapeHtml(text) {
        const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
        return text.replace(/[&<>"']/g, m => map[m]);
    }
});