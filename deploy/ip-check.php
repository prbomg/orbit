<?php
// Apache/mod_remoteip supplies REMOTE_ADDR. Never parse client-supplied
// X-Forwarded-For, Forwarded or X-Real-IP here.
declare(strict_types=1);
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, max-age=0');
header('Pragma: no-cache');
header('X-Content-Type-Options: nosniff');
header("Content-Security-Policy: default-src 'none'; frame-ancestors 'none'");
if (!in_array($_SERVER['REQUEST_METHOD'] ?? '', ['GET', 'HEAD'], true)) {
    http_response_code(405);
    header('Allow: GET, HEAD');
    exit;
}
$ip = $_SERVER['REMOTE_ADDR'] ?? '';
if (filter_var($ip, FILTER_VALIDATE_IP) === false) {
    http_response_code(503);
    echo '{"error":"address_unavailable"}';
    exit;
}
if ($_SERVER['REQUEST_METHOD'] !== 'HEAD') {
    echo json_encode(['ip' => $ip], JSON_THROW_ON_ERROR);
}
