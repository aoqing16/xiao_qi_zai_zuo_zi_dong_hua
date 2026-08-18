auto.waitFor();


log("🚀 开始启动自动跳过 OP 脚本...");

var lastEpisodeNum = "";
var isExecuting = false;
// 全局句柄
let globalWs = null;
let isConnected = false;
// 🟢 状态控制标志：检测到倍速 UI 后设为 true，解锁切集检测
var hasSpeedTriggered = false;
const BASE_WS = "wss://my-anime-op-api.de5.net/ws"; // 使用 Secure WebSocket
const baseUrl = "https://my-anime-op-api.de5.net/op";
const configPath = "/storage/emulated/0/脚本/跳过op/skip_config.json";

// 脚本退出监听
events.on("exit", function () {
    log("脚本正在退出,正在清理WebSocket连接")
    断开WebSocket连接()
})

// ==================== 1. 初始化 WebSocket 连接 ====================
function WebSocket连接初始化() {
    log("🔌 正在连接 WebSocket: " + BASE_WS);

    let OkHttpClient = okhttp3.OkHttpClient;
    let Request = okhttp3.Request;
    let WebSocketListener = okhttp3.WebSocketListener;

    // 设置超时时间
    let client = new OkHttpClient.Builder()
        .connectTimeout(10, java.util.concurrent.TimeUnit.SECONDS)
        .build();

    let request = new Request.Builder().url(BASE_WS).build();

    globalWs = client.newWebSocket(request, new JavaAdapter(WebSocketListener, {
        onOpen: function (webSocket, response) {
            isConnected = true;
            toastLog("✅ 服务器连接成功...");

            // 启动心跳线程保持连接活跃
            threads.start(function () {
                while (isConnected) {
                    sleep(25000); // 25秒发一次心跳
                    try {
                        if (isConnected && webSocket) {
                            webSocket.send("ping");
                        }
                    } catch (err) {
                        log("⚠️ 发送心跳失败: " + err);
                    }
                }
            });
        },
        onMessage: function (webSocket, text) {
            if (!text) return;

            // 1. 💥 关键修复：强制转为 JS 原生字符串，并清理所有不可见字符/空格
            let str = (text + "").replace(/[\s\uFEFF\xA0]/g, "").toLowerCase();

            // 2. 过滤心跳（用 indexOf 或 includes 更保险，即使带了杂质也能挡住）
            if (str === "pong" || str.indexOf("pong") !== -1 || str === "ping") {
                // log("丢弃心跳包: " + str); // 调试完可注释
                return; // 成功拦截！不再往下执行！
            }

            log("📩 [收到 WebSocket 推送]:\n" + text);
            WebSocket消息处理(text);
        },
        onClosing: function (webSocket, code, reason) {
            log("⚠️ WebSocket 正在关闭: " + reason);
            isConnected = false;
        },
        onClosed: function (webSocket, code, reason) {
            log("❌ WebSocket 已断开连接");
            isConnected = false;
        },
        onFailure: function (webSocket, t, response) {
            toastLog("⚠️ 服务器连接异常: " + t.getMessage());
            if (response != null) {
                log("⚠️ HTTP 状态码: " + response.code());
            }
            isConnected = false;
        }
    }));
}


// 主动强制断开 WebSocket 长连接
function 断开WebSocket连接() {
    log("🛑 正在主动强制断开 WebSocket 连接...");

    // 1. 改变状态标志，终止心跳 while 循环
    isConnected = false;

    // 3. 优雅关闭 + 超时强切
    if (globalWs) {
        // 💡 关键修正：用局部变量锁定句柄，并将全局句柄立刻清空
        let ws = globalWs;
        globalWs = null;

        try {
            // 先尝试优雅关闭
            ws.close(1000, "User Force Disconnect");
        } catch (e) {
            log("⚠️ 发送 close 指令异常: " + e.message);
        }

        // 3 秒超时保底：如果 3 秒内没响应，强制 cancel
        setTimeout(function () {
            try {
                // 即使已经正常断开了，对已关闭的 socket 调用 cancel 也不会报错
                ws.cancel();
                log("⚠️ 正常关闭超时/完成保底，已执行 cancel() 强制切断");
            } catch (e) {
            }
        }, 3000);
    }

    log("✅ 已发起断开连接请求。");
}

// 服务器消息响应和处理
function WebSocket消息处理(jsonStr) {
    if (typeof jsonStr === "string" && jsonStr.trim().toLowerCase() === "pong") {
        return;

    }
    try {
        let msg = JSON.parse(jsonStr);

        // 阶段 1 完成推送：下载完成，自动发起阶段 2 提交声纹
        if (msg.event === "DOWNLOAD_COMPLETE") {
            toastLog("🎉 下载完成！请提交 OP 声纹时间点...");
        }

        // 阶段 2 完成推送：声纹匹配入库成功
        else if (msg.event === "OP_MATCH_COMPLETE") {
            toastLog("🎊 《" + msg.anime + "》声纹匹配入库完成！");
            log("📊 最终获取的数据:\n" + JSON.stringify(msg.data, null, 2));
            log("msg.anime的值为:" + msg.anime);
            覆写数据文件(msg.anime, msg.data);
            // 构造新的json对象
            let new_msg_data = {
                [msg.anime]: msg.data
            };
            根据当前进度执行不同操作(new_msg_data);
        }

        // 异常/失败通知
        else if (msg.status === "error" || msg.event.endsWith("_FAILED") || msg.event.endsWith("_ERROR")) {
            toastLog("❌ 收到错误通知: " + msg.msg);
        }

    } catch (e) {
        log("解析 WebSocket 消息失败: " + e);
        log("收到非json格式的消息" + jsonStr)
    }
}

// 连接服务器
WebSocket连接初始化();
sleep(2500);


// =============================
// 1. 本地文件操作与数据管理
// =============================

// 读取本地 JSON 配置数据
function 读取本地数据() {
    try {
        if (files.exists(configPath)) {
            let jsonText = files.read(configPath);
            if (jsonText) {
                return JSON.parse(jsonText);
            }
        }
    } catch (err) {
        log("⚠️ 读取本地配置文件失败: " + err.message);
    }
    return null;
}

// 覆写 JSON 文件
/**
 * 传入剧名和op数据，构建新的json对象覆写本地文件
 * @param {剧名字符串} anime
 * @param {json对象} dataObj
 */
function 覆写数据文件(anime, dataObj) {
    try {
        let new_data = {
            [anime]: dataObj
        }
        files.createWithDirs(configPath);
        let jsonString = JSON.stringify(new_data, null, 2);
        files.write(configPath, jsonString);
        log("💾 已按 data 结构成功覆写配置文件:\n" + configPath);
    } catch (err) {
        log("❌ 保存配置文件失败: " + err.message);
    }
}

// =============================
// 2. UI 查找与解锁辅助函数
// =============================

// 根据 Bounds 范围过滤获取解锁节点
function 查找UI锁节点() {
    let w = device.width;
    let h = device.height;

    let minX = w * 0.88;
    let maxX = w * 1.00;
    let minY = h * 0.35;
    let maxY = h * 0.65;

    let lockNode = className("android.view.View").find().filter(function (node) {
        let b = node.bounds();
        if (b.width() <= 0 || b.height() <= 0) return false;

        let centerX = b.centerX();
        let centerY = b.centerY();

        return (centerX >= minX && centerX <= maxX) &&
            (centerY >= minY && centerY <= maxY);
    })[0];

    return lockNode || null;
}

// 检查并解锁播放器（仅当存在“当前已锁定”文本时触发）
function 画面解锁() {
    let isLockedText = textContains("当前已锁定").visibleToUser(true).exists() ||
        descContains("当前已锁定").visibleToUser(true).exists();

    if (isLockedText) {
        log("⚠️ 画面提示【当前已锁定】，尝试获取解锁按钮并点击...");
        let lockNode = 查找UI锁节点();

        if (lockNode) {
            if (!lockNode.click()) {
                let b = lockNode.bounds();
                click(b.centerX(), b.centerY());
            }
            log("🔓 已点击解锁按钮");
            sleep(500);
            return true;
        } else {
            log("❌ 已检测到锁定提示，但未在目标 Bounds 区域内寻找到解锁节点");
        }
    }
    return false;
}

// 带重试与自动唤醒解锁的剧集信息获取（含短横线 "-": 如 "摇曳百合3 - 第4集"）
function 剧名剧集信息获取主函数(maxRetries) {
    maxRetries = maxRetries || 3;
    for (let i = 1; i <= maxRetries; i++) {
        let info = 获取剧名剧集工具函数();
        if (info) return info;

        log(`⏳ [第 ${i}/${maxRetries} 次] 未直接获取到剧名，尝试点击屏幕唤醒 UI...`);
        click(device.width / 2, device.height / 2);
        sleep(400);

        画面解锁();

        info = 获取剧名剧集工具函数();
        if (info) return info;

        sleep(500);
    }
    return null;
}

// 静默获取切集 UI 上的集数（格式如 "摇曳百合3 第4集"，严格不带短横线 "-"）
function 切集检测() {
    let switchNode = className("android.view.View")
        .descMatches(/^[^-]+?\s+第(\d+)[集话期卷篇]$/)
        .visibleToUser(true)
        .findOnce();

    if (switchNode) {
        let fullText = switchNode.desc();
        let match = fullText.match(/^[^-]+?\s+第(\d+)[集话期卷篇]$/);
        if (match) {
            return match[1]; // 提取集数数字字符串
        }
    }
    return null;
}

// 带重试与自动唤醒解锁的当前进度获取
function 获取当前进度主函数(maxRetries) {
    maxRetries = maxRetries || 3;
    for (let i = 1; i <= maxRetries; i++) {
        let time = 获取当前播放时间();
        if (time >= 0) return time;

        log(`⏳ [第 ${i}/${maxRetries} 次] 未获取到时间进度，尝试点击屏幕唤醒 UI...`);
        click(device.width / 2, device.height / 2);
        sleep(400);

        画面解锁();

        time = 获取当前播放时间();
        if (time >= 0) return time;

        sleep(300);
    }
    return -1;
}

// 时间字符串（如 "01:25" 或 "01:10:20"）转为总秒数
function 时间格式转换(timeStr) {
    if (!timeStr) return -1;
    let parts = timeStr.trim().split(":").map(Number);
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return -1;
}

// 获取当前播放时间点（秒）
function 获取当前播放时间() {
    let node = className("android.view.View").descContains("/").visibleToUser(true).findOnce();
    if (node) {
        let text = node.desc(); // 格式如: "01:20 / 24:00"
        let currentStr = text.split("/")[0].trim();
        return 时间格式转换(currentStr);
    }
    return -1;
}

// 获取当前 UI 上的标题与集数（含短横线 "-": 如 "摇曳百合3 - 第4集"）
function 获取剧名剧集工具函数() {
    let titleNode = className("android.view.View")
        .descMatches(/.*?\s*-\s*第\s*\d+\s*[集话期卷篇].*/)
        .visibleToUser(true)
        .findOnce();

    if (titleNode) {
        let fullText = titleNode.desc();
        let reg = /^(.*?)\s*-\s*第\s*(\d+)\s*[集话期卷篇]?/;
        let match = fullText.match(reg);
        if (match) {
            return {
                dramaName: match[1].trim(),
                episodeNum: parseInt(match[2], 10).toString()
            };
        }
    }
    return null;
}

// 等待切集专属 UI（如："摇曳百合3 第4集"）完全消失
function 切集UI消失检测() {
    log("⏳ 正在等待切集 UI 完全消失...");

    let switchNodeFetcher = function () {
        return className("android.view.View")
            .descMatches(/^[^-]+?\s+第\d+[集话期卷篇]$/)
            .visibleToUser(true)
            .findOnce();
    };

    let waitCount = 0;
    while (waitCount < 60) { // 最多等待 10 秒
        let switchNode = switchNodeFetcher();

        if (!switchNode) {
            log("✅ 切集 UI 已完全消失！");
            sleep(1000); // 缓冲 1 秒，确保画面及动画彻底收起
            return true;
        }

        log(`⏳ 切集 UI [${switchNode.desc()}] 依然存在，等待消失...`);
        sleep(500);
        waitCount++;
    }

    log("⚠️ 等待切集 UI 消失超时，继续执行后续逻辑。");
    return false;
}

// =============================
// 3. 执行核心逻辑（进度校验 & 拖动进度条）
// =============================

// 根据 targetSec 找到进度条并点击跳转（带唤醒与重试机制）
function 进度跳转主函数(targetSec, maxRetries) {
    maxRetries = maxRetries || 3;

    for (let i = 1; i <= maxRetries; i++) {
        let timeNode = className("android.view.View").descContains("/").visibleToUser(true).findOnce();
        let barNode = className("android.view.View").scrollable(true).clickable(true).depth(8).visibleToUser(true).findOnce();

        if (timeNode && barNode) {
            let parts = timeNode.desc().split("/");
            if (parts.length >= 2) {
                let totalSec = 时间格式转换(parts[1].trim());
                if (totalSec > 0) {
                    let ratio = Math.max(0, Math.min(1, targetSec / totalSec));
                    let b = barNode.bounds();
                    let targetX = b.left + b.width() * ratio;
                    let targetY = b.centerY();

                    log(`👆 点击进度条位置: (${Math.round(targetX)}, ${Math.round(targetY)}) | 跳转比例: ${(ratio * 100).toFixed(1)}%`);
                    click(targetX, targetY);
                    log("⚡ 跳过 OP 操作执行完成！");
                    return true;
                }
            }
        }

        log(`⏳ [第 ${i}/${maxRetries} 次] 未获取到进度条 UI，尝试点击屏幕唤醒播放器控件...`);
        click(device.width / 2, device.height / 2);
        sleep(400);

        画面解锁();

        sleep(300);
    }

    log("❌ 经过多次重试后，仍未成功获取进度条或总时长，无法执行精准跳转。");
    return false;
}

// 根据配置进行校验与时间点控制
/**
 *
 * @param {*} dataObj 包含剧集名和op数据的js对象
 * @returns
 */
function 根据当前进度执行不同操作(dataObj) {
    let mediaInfo = 剧名剧集信息获取主函数(3);
    let currentTime = 获取当前进度主函数(3);

    if (!mediaInfo) {
        log("⚠️ 重试后仍无法获取剧集信息，跳过进度校验。");
        return;
    }

    let dramaName = mediaInfo.dramaName;
    let episodeNum = mediaInfo.episodeNum;

    log(`🔎 校验播放信息: 《${dramaName}》第 ${episodeNum} 集 | 当前进度: ${currentTime >= 0 ? currentTime + "s" : "未知"}`);

    if (dataObj && dataObj[dramaName] && dataObj[dramaName][episodeNum]) {
        let opConfig = dataObj[dramaName][episodeNum];
        let opStartSec = opConfig.opStartSec;
        let targetSec = opConfig.targetSec;

        log(`🎯 匹配到 OP 配置 -> OP起始点: ${opStartSec}s | 跳过目标点: ${targetSec}s`);

        if (currentTime < 0) {
            log("⚠️ 获取当前进度秒数失败，直接尝试跳转至目标点...");
            进度跳转主函数(targetSec);
            return;
        }

        // 情况 1: 在 OP 结束后
        if (currentTime >= targetSec) {
            log(`⏩ 当前播放进度 (${currentTime}s) 已超过 OP 结束点 (${targetSec}s)，无需跳过。`);
            return;
        }

        // 情况 2: 正处于 OP 中
        if (currentTime >= opStartSec && currentTime < targetSec) {
            log(`🎬 当前进度 (${currentTime}s) 正处于 OP 中，立即执行跳转...`);
            进度跳转主函数(targetSec);
            return;
        }

        // 情况 3: 在 OP 开始之前 (currentTime < opStartSec)
        if (currentTime < opStartSec) {
            let remainToStartSec = opStartSec - currentTime;
            log(`⏳ 当前进度 (${currentTime}s) 处于 OP 开始前，距离 OP 开始还剩 ${remainToStartSec}s。`);

            if (remainToStartSec > 2) {
                let firstWaitSec = remainToStartSec - 2;
                log(`⏸️ [后台等待] 先等待 ${firstWaitSec}s 至 OP 开始前倒数第 2 秒...`);
                sleep(firstWaitSec * 1000);

                log("🔍 到了 OP 开始前倒数 2 秒，重新校验当前播放进度...");
                let recheckTime = 获取当前进度主函数(3);
                log(`⏱️ 再次校验时间: ${recheckTime >= 0 ? recheckTime + "s" : "未知"}`);

                if (recheckTime >= 0 && recheckTime < opStartSec) {
                    let finalWait = opStartSec - recheckTime;
                    log(`⏳ 仍在 OP 开始前，等待剩余 ${finalWait}s 执行跳过...`);
                    if (finalWait > 0) sleep(finalWait * 1000);
                    进度跳转主函数(targetSec);
                } else if (recheckTime >= opStartSec && recheckTime < targetSec) {
                    log("🎬 重新校验发现已进入 OP，立即执行跳过...");
                    进度跳转主函数(targetSec);
                } else {
                    log("⏩ 重新校验发现进度已超过 OP 结束点，放弃跳转。");
                }
            } else {
                log(`⏳ 距离 OP 开始不足 2 秒 (${remainToStartSec}s)，等待后跳过...`);
                sleep(remainToStartSec * 1000);
                进度跳转主函数(targetSec);
            }
        }
    } else {
        log(`⚠️ 配置文件中未查找到《${dramaName}》第 ${episodeNum} 集的 OP 时间戳。`);
    }
}

// 调度执行流程：优先本地数据，不存在则发送 API 请求
function 获取op时间戳数据() {
    log("🔔 触发处理流程，获取剧集信息...");

    let mediaInfo = 剧名剧集信息获取主函数(3);
    if (!mediaInfo) {
        log("❌ 无法解析当前剧名与集数，退出流程。");
        return;
    }

    let dramaName = mediaInfo.dramaName;
    let episodeNum = mediaInfo.episodeNum;
    log(`🎬 当前播放: 《${dramaName}》第 ${episodeNum} 集`);

    // 1. 优先查本地 json 文件
    let localData = 读取本地数据();
    if (localData && localData[dramaName] && localData[dramaName][episodeNum]) {
        log("📁 本地配置文件中已找到该集 OP 数据，直接使用本地配置，跳过网络请求！");
        根据当前进度执行不同操作(localData);
        return;
    }

    // 2. 本地无数据时，发送 API 网络请求
    log("📡 本地无该集数据，开始向服务器发送请求...");
    let requestUrl = `${baseUrl}?anime=${encodeURIComponent(dramaName)}&episode=${encodeURIComponent(episodeNum)}`;
    let isSuccess = false;

    for (let retry = 1; retry <= 3; retry++) {
        try {
            log(`⏳ 正在发送请求 (第 ${retry}/3 次)...`);
            let res = http.get(requestUrl, {
                timeout: 15000,
                headers: {
                    "User-Agent": "Mozilla/5.0 (Linux; Android 10; Mobile) AppleWebKit/537.36"
                }
            });

            if (res.statusCode === 200) {
                let responseText = res.body.string();
                log("✅ 收到服务器响应:\n" + responseText);

                let resJson = JSON.parse(responseText);

                if (resJson.status === "processing_download") {
                    log(`⏳ 服务端提示: ${resJson.msg}`);
                } else if (resJson.status === "success") {
                    if (resJson.data) {
                        log("resjson.anime值为:" + resJson.anime);
                        覆写数据文件(resJson.anime, resJson.data);
                        // 构造新对象
                        let new_resjson_data = {
                            [resJson.anime]: resJson.data
                        }
                        根据当前进度执行不同操作(new_resjson_data);
                    }
                }
                isSuccess = true;
                break;
            }
        } catch (err) {
            log(`❌ 请求失败 (${err.message})`);
        }
        sleep(1000);
    }

    if (!isSuccess) {
        log("💥 尝试 3 次后均未能成功获取接口数据。");
    }
}

// =============================
// 4. 线程管理与核心逻辑交互
// =============================

// 1️⃣ 【倍速】检测线程：检测到倍速 UI 后开启切集检测权限，并执行一次跳过逻辑
threads.start(function () {
    log("👀 启动【倍速】UI 检测线程...");
    while (true) {
        try {
            if (!hasSpeedTriggered) {
                let speedExist = className("android.view.View").desc("倍速").visibleToUser(true).exists();

                if (speedExist) {
                    log("⚡ 检测到【倍速】UI 出现！已开启切集检测权限，并准备执行首次跳过逻辑...");
                    hasSpeedTriggered = true; // 开启切集检测开关

                    // 独立执行一次跳过逻辑（无论其成功与否，切集检测已解锁）
                    if (!isExecuting) {
                        isExecuting = true;
                        获取op时间戳数据();
                    }
                }
            }
        } catch (e) {
            // 忽略 UI 异常
        }

        sleep(800);
    }
});

// 2️⃣ 【切集】监听线程：只要【倍速】已出现过 (`hasSpeedTriggered === true`) 即运行
threads.start(function () {
    log("👀 切集监听后台线程已启动...");
    while (true) {
        try {
            // 前置条件：只要倍速 UI 出现过，即允许进行切集检测
            if (hasSpeedTriggered) {
                let silentEp = 切集检测();

                if (silentEp) {
                    // 检测到切集 UI（如 "摇曳百合3 第4集"）且集数变更
                    if (silentEp !== lastEpisodeNum) {
                        log("🎬 检测到切集 UI: 第 " + silentEp + " 集");
                        lastEpisodeNum = silentEp;
                        isExecuting = false; // 解锁标志位

                        // 启动临时线程等待切集 UI 消失后再去抓数据和执行跳过
                        threads.start(function () {
                            // 1. 阻塞直到切集 UI 完全消失
                            切集UI消失检测();

                            // 2. 切集 UI 消失后开始提取配置并校验跳转
                            if (!isExecuting) {
                                isExecuting = true;
                                获取op时间戳数据();
                            }
                        });
                    }
                }
            }
        } catch (e) {
            // 忽略 UI 刷新/动画切帧瞬间的空指针与异常
        }

        sleep(1500);
    }
});

// 3️⃣ 【收藏】重置线程：检测到“收藏”UI 出现时，重置状态并重新锁死切集检测
threads.start(function () {
    log("👀 启动【收藏】重置监听线程...");
    while (true) {
        try {
            let isFavorExist = className("android.view.View").desc("收藏").visibleToUser(true).exists();

            if (isFavorExist) {
                if (hasSpeedTriggered) {
                    log("🔄 检测到【收藏】UI 出现，重置状态！锁死切集检测，等待下一次倍速 UI 出现...");
                    hasSpeedTriggered = false; // 重新锁定切集检测
                    lastEpisodeNum = "";        // 清空历史集数记录
                    isExecuting = false;
                }
            }
        } catch (e) {
            // 忽略异常
        }

        sleep(1000);
    }
});
// =========================================================
// 5. 悬浮窗交互与 OP 时间戳采集提交 (含坐标区域显示与前台服务级常驻通知)
// =========================================================

importClass(android.provider.Settings);
importClass(android.app.NotificationManager);
importClass(android.app.NotificationChannel);
importClass(android.app.Notification);
importClass(android.app.PendingIntent);
importClass(android.content.Intent);
importClass(android.content.IntentFilter);
importClass(android.content.BroadcastReceiver);
importClass(android.os.Build);

// 1. 检查并申请悬浮窗权限
if (!Settings.canDrawOverlays(context)) {
    toastLog("⚠️ 未检测到悬浮窗权限，准备跳转授权页面...");
    try {
        floaty.requestPermission();
    } catch (e) {
        let intent = new Intent(
            Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
            android.net.Uri.parse("package:" + context.getPackageName())
        );
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        context.startActivity(intent);
    }
}

var deviceWidth = device.width;
var areaLeft = Math.floor(deviceWidth * 0.2);
var areaRight = Math.floor(deviceWidth * 0.8);
var areaBottom = 260; // 顶部 260px 区域

// 2. 创建主悬浮控制窗
var 主悬浮窗 = floaty.window(
    <frame gravity="center">
        <button id="btnSubmitOp" text="📍 标记OP" width="90" height="40"
                bg="#80000000" textColor="#ffffff" textSize="12sp"/>
    </frame>
);

// 3. 创建顶部的“隐藏目标坐标区域”悬浮框 (带显眼的虚线/半透明背景与坐标文本)
var 隐藏区域提示悬浮窗 = floaty.window(
    <frame id="zoneFrame" gravity="center" bg="#aa333333" cornerRadius="16dp">
        <text id="zoneText" text="" textColor="#ffffff" textSize="12sp" gravity="center" padding="8 4"/>
    </frame>
);

// 初始化坐标
var defaultX = 100, defaultY = 300;
主悬浮窗.setPosition(defaultX, defaultY);
隐藏区域提示悬浮窗.setPosition(-2000, -2000); // 默认隐藏目标区域

var 主动控制_悬浮窗状态 = true;
var isRecordingOp = false;
var opStartSecRecorded = 0;
var recordedMediaInfo = null;

// 触摸事件变量
var touchX = 0, touchY = 0;
var windowX, windowY;
var downTime;

// 4. 显隐控制与 UI 线程同步
function 主动隐藏悬浮窗() {
    ui.run(function () {
        主悬浮窗.setPosition(-2000, -2000);
        隐藏区域提示悬浮窗.setPosition(-2000, -2000);
        主动控制_悬浮窗状态 = false;
    });
}

function 包名隐藏悬浮窗() {
    ui.run(function () {
        主悬浮窗.setPosition(-2000, -2000);
        隐藏区域提示悬浮窗.setPosition(-2000, -2000);
    });
}

function 主动显示悬浮窗() {
    ui.run(function () {
        主悬浮窗.setPosition(defaultX, defaultY);
        主动控制_悬浮窗状态 = true;
    });
}

function 包名显示悬浮窗() {
    ui.run(function () {
        主悬浮窗.setPosition(defaultX, defaultY);
    });
}

function 悬浮窗显隐切换() {
    if (主动控制_悬浮窗状态) {
        主动隐藏悬浮窗();
        toastLog("🙈 悬浮窗已隐藏");
    } else {
        主动显示悬浮窗();
        toastLog("👀 悬浮窗已恢复显示");
    }
}

// 初始化隐藏悬浮窗,等待包名唤醒
包名隐藏悬浮窗();
// 5. 悬浮窗拖动、点击与“坐标目标区”视觉交互
主悬浮窗.btnSubmitOp.setOnTouchListener(function (view, event) {
    switch (event.getAction()) {
        case event.ACTION_DOWN:
            touchX = event.getRawX();
            touchY = event.getRawY();
            windowX = 主悬浮窗.getX();
            windowY = 主悬浮窗.getY();
            downTime = new Date().getTime();

            // 按下时：在屏幕顶部弹出明确的坐标区域框
            ui.run(function () {
                隐藏区域提示悬浮窗.setSize(areaRight - areaLeft, areaBottom);
                隐藏区域提示悬浮窗.setPosition(areaLeft, 30);
                隐藏区域提示悬浮窗.zoneFrame.setBackgroundColor(android.graphics.Color.parseColor("#CC222222"));
                隐藏区域提示悬浮窗.zoneText.setText(`📥 拖入此处隐藏`);
            });
            return true;

        case event.ACTION_MOVE:
            let curMoveX = event.getRawX();
            let curMoveY = event.getRawY();
            let newX = windowX + (curMoveX - touchX);
            let newY = windowY + (curMoveY - touchY);
            主悬浮窗.setPosition(newX, newY);

            // 判断悬浮窗中心点坐标是否在目标隐藏坐标区域内
            if (curMoveY < areaBottom && curMoveX > areaLeft && curMoveX < areaRight) {
                ui.run(function () {
                    // 进入隐藏区域：框体变红高亮
                    隐藏区域提示悬浮窗.zoneFrame.setBackgroundColor(android.graphics.Color.parseColor("#DDEE3322"));
                    隐藏区域提示悬浮窗.zoneText.setText(`💥 松开手指立即隐藏\n[ X:${Math.floor(curMoveX)}, Y:${Math.floor(curMoveY)} ]`);
                });
            } else {
                ui.run(function () {
                    // 未进入区域：恢复暗色提示
                    隐藏区域提示悬浮窗.zoneFrame.setBackgroundColor(android.graphics.Color.parseColor("#CC222222"));
                    隐藏区域提示悬浮窗.zoneText.setText(`📥 拖入此处隐藏\n[ 范围: Y < ${areaBottom}px ]`);
                });
            }
            return true;

        case event.ACTION_UP:
            let curX = event.getRawX();
            let curY = event.getRawY();
            let moveDistance = Math.abs(curX - touchX) + Math.abs(curY - touchY);

            // 抬起手指：隐藏提示框
            ui.run(function () {
                隐藏区域提示悬浮窗.setPosition(-2000, -2000);
            });

            // A. 点击事件
            if (new Date().getTime() - downTime < 250 && moveDistance < 15) {
                threads.start(op标记并提交请求);
                return true;
            }

            // B. 落在坐标区域内 -> 触发隐藏
            if (curY < areaBottom && curX > areaLeft && curX < areaRight) {
                主动隐藏悬浮窗();
                toastLog("🙈 悬浮窗已隐藏，可在通知栏重新开启");
            } else {
                // 记录最新放置坐标
                defaultX = 主悬浮窗.getX();
                defaultY = 主悬浮窗.getY();
            }
            return true;
    }
    return true;
});

// 6. 防划走常驻通知栏模块
const NOTIFY_ACTION = "com.autojs.action.TOGGLE_OP_FLOATY_PERMANENT";
const CHANNEL_ID = "op_recorder_channel_v3";
const NOTIFY_ID = 3003;

function setupNotification() {
    let manager = context.getSystemService(context.NOTIFICATION_SERVICE);

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        let channel = new NotificationChannel(CHANNEL_ID, "OP标记控制服务", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("保持前台服务常驻并控制悬浮窗");
        channel.enableVibration(false);
        channel.setSound(null, null);
        manager.createNotificationChannel(channel);
    }

    // 注册广义广播接收
    let filter = new IntentFilter(NOTIFY_ACTION);
    let receiver = new JavaAdapter(BroadcastReceiver, {
        onReceive: function (ctx, intent) {
            threads.start(function () {
                悬浮窗显隐切换();
                // 每次点击后重新刷新补发通知，防止系统清除
                refreshNotification(manager);
            });
        }
    });

    if (Build.VERSION.SDK_INT >= 33) {
        context.registerReceiver(receiver, filter, context.RECEIVER_EXPORTED);
    } else {
        context.registerReceiver(receiver, filter);
    }

    refreshNotification(manager);

    // 定时自动巡检守护：如果通知被强行划走，每 5 秒自动补充生成
    setInterval(function () {
        refreshNotification(manager);
    }, 5000);
}

function refreshNotification(manager) {
    let intent = new Intent(NOTIFY_ACTION);
    intent.setPackage(context.getPackageName());

    let flags = PendingIntent.FLAG_UPDATE_CURRENT;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
        flags |= PendingIntent.FLAG_IMMUTABLE;
    }
    let pendingIntent = PendingIntent.getBroadcast(context, 0, intent, flags);

    let builder;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        builder = new Notification.Builder(context, CHANNEL_ID);
    } else {
        builder = new Notification.Builder(context);
    }

    let notification = builder
        .setContentTitle("🎬 OP 时间戳采集运行中")
        .setContentText("点击此条通知：显示 / 隐藏悬浮控制窗")
        .setSmallIcon(android.R.drawable.ic_menu_camera)
        .setContentIntent(pendingIntent)
        .setOngoing(true) // 标识为 Ongoing 服务通知
        .build();

    // 强制赋予绝对不可清除属性
    notification.flags |= Notification.FLAG_NO_CLEAR | Notification.FLAG_ONGOING_EVENT | Notification.FLAG_FOREGROUND_SERVICE;

    manager.notify(NOTIFY_ID, notification);
}

// 启动常驻守护通知
setupNotification();


// 前台包名检测及悬浮窗显隐控制
// ==================== 配置区域 ====================

// 1. 在独立子线程中运行，绝不阻塞主线程和日志系统
threads.start(function () {
    let lastPkg = "";
    let 已进入目标app = false
    while (true) {
        let currentPkg = null;

        try {
            // 方式 A：优先尝试从当前活跃窗口的根节点抓取包名（最稳健）
            let service = auto.service;
            if (service) {
                let rootNode = service.getRootInActiveWindow();
                if (rootNode) {
                    let p = rootNode.getPackageName();
                    if (p) {
                        currentPkg = String(p);
                    }
                    // 必须手动释放/帮助 GC，防止无障碍节点在内存中堆积导致 Binder 阻塞
                    rootNode.recycle();
                }
            }

            // 方式 B：方式 A 抓取失败时进行降级兜底
            if (!currentPkg || currentPkg === "null") {
                if (typeof currentPackage === "function") {
                    currentPkg = currentPackage();
                }
            }
        } catch (e) {
            // 捕获可能出现的 Binder 异常，防止线程崩溃
        }

        // 2. 状态防抖：只有包名发生改变时才打印日志，避免无限高频刷新日志管道
        if (currentPkg && currentPkg !== lastPkg && currentPkg !== "null") {
            lastPkg = currentPkg;
            // log(`[${new Date().toLocaleTimeString()}] 📱 切换前台应用: ${currentPkg}`);

            // 💡 匹配目标应用（如微信）
            if (currentPkg === "com.tingfeng.tool") {
                log("进入目标app");
                已进入目标app = true;
                if (主动控制_悬浮窗状态) {
                    包名显示悬浮窗();

                }
                ;

            } else if (已进入目标app) {
                log("离开目标app")
                已进入目标app = false;
                包名隐藏悬浮窗()

            }

        }

        // 3. 核心：设定合理的休眠间隔（800ms），给系统 Binder 通道和 CPU 喘息时间
        sleep(1000);
    }
});


// 7. 处理点击标记按钮的核心逻辑
function op标记并提交请求() {
    if (!isRecordingOp) {
        let info = 剧名剧集信息获取主函数(2);
        let currentSec = 获取当前进度主函数(2);

        if (!info) {
            toastLog("❌ 未能获取到当前剧名与集数，请确保播放器 UI 可见");
            return;
        }
        if (currentSec < 0) {
            toastLog("❌ 未能获取到当前进度时间，请确保播放控件已展开");
            return;
        }

        recordedMediaInfo = info;
        opStartSecRecorded = currentSec;
        isRecordingOp = true;

        ui.run(function () {
            主悬浮窗.btnSubmitOp.setText("⏹ 标记结尾");
        });

        toastLog(`✅ 已记录 OP 开头: ${opStartSecRecorded}s\n👉 请在 OP 结尾处暂停，并再次点击此按钮`);
    } else {
        let currentSec = 获取当前进度主函数(2);

        if (currentSec < 0) {
            toastLog("❌ 未能获取到当前进度时间，请确保播放控件已展开");
            return;
        }

        if (currentSec <= opStartSecRecorded) {
            toastLog(`⚠️ 结尾时间 (${currentSec}s) 必须大于开头时间 (${opStartSecRecorded}s)，请重新操作`);
            return;
        }

        let opEndSecRecorded = currentSec;

        ui.run(function () {
            主悬浮窗.btnSubmitOp.setText("📍 标记OP");
        });
        isRecordingOp = false;

        toastLog(`🎬 采集完成!\n《${recordedMediaInfo.dramaName}》第 ${recordedMediaInfo.episodeNum} 集\nOP: ${opStartSecRecorded}s -> ${opEndSecRecorded}s\n📡 正在发送数据...`);

        let cleanEpisode = 1;
        if (recordedMediaInfo.episodeNum) {
            let match = String(recordedMediaInfo.episodeNum).match(/\d+/);
            if (match) {
                cleanEpisode = parseInt(match[0], 10);
            }
        }

        let payload = {
            "anime": String(recordedMediaInfo.dramaName),
            "episode": cleanEpisode,
            "op_start": Number(opStartSecRecorded.toFixed(1)),
            "op_end": Number(opEndSecRecorded.toFixed(1))
        };

        post请求(payload);
    }
}

// 8. 使用原生 OkHttp 发送 POST 请求
function post请求(payload) {
    let submitUrl = "https://my-anime-op-api.de5.net/op/submit";
    let jsonString = JSON.stringify(payload);
    log("📤 [准备发送 Payload]: " + jsonString);

    try {
        importClass(okhttp3.OkHttpClient);
        importClass(okhttp3.Request);
        importClass(okhttp3.RequestBody);
        importClass(okhttp3.MediaType);
        importClass(java.util.concurrent.TimeUnit);

        let client = new OkHttpClient.Builder()
            .connectTimeout(120, TimeUnit.SECONDS)
            .readTimeout(120, TimeUnit.SECONDS)
            .writeTimeout(120, TimeUnit.SECONDS)
            .retryOnConnectionFailure(false)
            .build();

        let JSON_TYPE = MediaType.parse("application/json; charset=utf-8");
        let body = RequestBody.create(JSON_TYPE, jsonString);

        let request = new Request.Builder()
            .url(submitUrl)
            .post(body)
            .addHeader("User-Agent", "Mozilla/5.0 (Linux; Android 10; Mobile)")
            .build();

        let response = client.newCall(request).execute();
        let statusCode = response.code();
        let resBodyStr = response.body().string();

        log(`📥 [收到响应] HTTP ${statusCode} | 内容: ${resBodyStr}`);

        if (statusCode === 200) {
            toastLog("🎉 OP 片头时间戳提交成功！");
        } else {
            toastLog(`❌ 提交失败 (HTTP ${statusCode})`);
        }
    } catch (err) {
        log("❌ OkHttp 请求异常: " + err);
        toastLog("❌ 请求发送失败，请检查网络或服务地址");
    }
}

// 9. 主进程常驻
setInterval(() => {
}, 10000);