const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const port = 3000;

// 创建上传文件夹
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}

// 存储在线设备
const onlineDevices = new Map();

// 存储传输历史
const transferHistory = new Map();

// 获取客户端IP地址的路由
app.get('/get-client-ip', (req, res) => {
    const ip = req.headers['x-forwarded-for'] || 
               req.connection.remoteAddress || 
               req.socket.remoteAddress;
    
    // 处理IPv6格式的IP地址
    const ipv4 = ip.includes('::ffff:') ? ip.split('::ffff:')[1] : ip;
    res.json({ ip: ipv4 });
});

// 配置文件存储
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'uploads/')
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + '-' + file.originalname);
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 500 * 1024 * 1024 } // 500MB限制
});

// 提供静态文件访问
app.use(express.static(__dirname));

// WebSocket 连接处理
io.on('connection', (socket) => {
    console.log('新设备连接');
    let deviceIP = '';

    // 处理设备信息
    socket.on('deviceInfo', (info) => {
        deviceIP = info.ip;
        const deviceInfo = {
            id: socket.id,
            name: info.deviceName,
            type: info.deviceType,
            ip: info.ip,
            connectTime: new Date().toLocaleString(),
            transferCount: transferHistory.get(info.ip)?.length || 0
        };
        onlineDevices.set(socket.id, deviceInfo);
        
        io.emit('updateOnlineDevices', Array.from(onlineDevices.values()));
    });

    // 处理断开连接
    socket.on('disconnect', () => {
        onlineDevices.delete(socket.id);
        io.emit('updateOnlineDevices', Array.from(onlineDevices.values()));
        console.log(`设备断开连接: ${deviceIP}`);
    });

    // 处理文件传输进度
    socket.on('uploadProgress', (progress) => {
        socket.broadcast.emit('fileProgress', {
            deviceId: socket.id,
            progress: progress
        });
    });
});

// 获取文件列表
app.get('/files', (req, res) => {
    fs.readdir(uploadDir, (err, files) => {
        if (err) {
            return res.status(500).json({ error: '无法读取文件列表' });
        }
        
        const fileList = files.map(filename => {
            const stats = fs.statSync(path.join(uploadDir, filename));
            const uploadInfo = transferHistory.get(filename) || {};
            
            return {
                name: filename.substring(filename.indexOf('-', filename.indexOf('-') + 1) + 1),
                originalName: filename,
                size: stats.size,
                uploadTime: stats.mtime.toLocaleString(),
                uploader: uploadInfo.uploader || '未知设备',
                downloads: uploadInfo.downloads || 0
            };
        });
        
        res.json(fileList);
    });
});

// 处理文件上传
app.post('/upload', upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: '没有文件被上传' });
    }

    const ip = req.headers['x-forwarded-for'] || 
               req.connection.remoteAddress || 
               req.socket.remoteAddress;
    const ipv4 = ip.includes('::ffff:') ? ip.split('::ffff:')[1] : ip;
    
    // 记录传输历史
    const history = transferHistory.get(ipv4) || [];
    history.push({
        type: 'upload',
        filename: req.file.originalname,
        time: new Date().toLocaleString(),
        size: req.file.size
    });
    transferHistory.set(ipv4, history);
    
    // 记录文件信息
    transferHistory.set(req.file.filename, {
        uploader: `设备(${ipv4})`,
        uploadTime: new Date().toLocaleString(),
        downloads: 0
    });
    
    io.emit('fileUploaded', {
        name: req.file.originalname,
        size: req.file.size,
        uploadTime: new Date().toLocaleString(),
        uploader: `设备(${ipv4})`
    });
    
    res.redirect('/');
});

// 处理文件下载
app.get('/download/:filename', (req, res) => {
    const filename = req.params.filename;
    const filepath = path.join(uploadDir, filename);
    
    if (fs.existsSync(filepath)) {
        // 更新下载次数
        const fileInfo = transferHistory.get(filename) || {};
        fileInfo.downloads = (fileInfo.downloads || 0) + 1;
        transferHistory.set(filename, fileInfo);
        
        // 记录下载历史
        const ip = req.headers['x-forwarded-for'] || 
                  req.connection.remoteAddress || 
                  req.socket.remoteAddress;
        const ipv4 = ip.includes('::ffff:') ? ip.split('::ffff:')[1] : ip;
        
        const history = transferHistory.get(ipv4) || [];
        history.push({
            type: 'download',
            filename: filename.substring(filename.indexOf('-', filename.indexOf('-') + 1) + 1),
            time: new Date().toLocaleString()
        });
        transferHistory.set(ipv4, history);
        
        res.download(filepath);
    } else {
        res.status(404).json({ error: '文件不存在' });
    }
});

// 获取传输历史
app.get('/transfer-history', (req, res) => {
    const ip = req.headers['x-forwarded-for'] || 
               req.connection.remoteAddress || 
               req.socket.remoteAddress;
    const ipv4 = ip.includes('::ffff:') ? ip.split('::ffff:')[1] : ip;
    
    res.json(transferHistory.get(ipv4) || []);
});

// 启动服务器
server.listen(port, '0.0.0.0', () => {
    const networkInterfaces = require('os').networkInterfaces();
    let ipAddress = '';
    
    Object.keys(networkInterfaces).forEach((interfaceName) => {
        const interfaces = networkInterfaces[interfaceName];
        interfaces.forEach((interface) => {
            if (interface.family === 'IPv4' && !interface.internal) {
                ipAddress = interface.address;
            }
        });
    });
    
    console.log(`服务器运行在 http://localhost:${port}`);
    console.log(`局域网访问地址：http://${ipAddress}:${port}`);
}); 