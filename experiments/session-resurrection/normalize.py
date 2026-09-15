"""Explicit text-only archive projections for consultation experiments.

Never changes the source. Raw source and normalized output belong in private storage.
This is a bounded decoder, not a general provider-compatible history importer.
"""
import hashlib
import json
from collections import Counter
from pathlib import Path


def digest(data):
    return hashlib.sha256(data).hexdigest()


def text_blocks(content, omissions):
    if isinstance(content, str):
        return content
    parts = []
    for block in content or []:
        if not isinstance(block, dict):
            omissions["non_text_part"] += 1
        elif block.get("type") in ("text", "input_text", "output_text"):
            parts.append(block.get("text", ""))
        else:
            omissions[block.get("type", "unknown_block")] += 1
    return "\n".join(parts)


def normalize(provider, path, leaf=None, conversation_id=None):
    raw = Path(path).read_bytes()
    omissions = Counter()
    messages = []
    session_id = None
    version = None
    selected_leaf = leaf
    if provider == "chatgpt":
        conversation = json.loads(raw)
        if isinstance(conversation, list):
            if not conversation_id:
                raise ValueError('Select an exact conversation ID from this ChatGPT export')
            matches=[c for c in conversation if c.get('id',c.get('conversation_id'))==conversation_id]
            if len(matches)!=1:
                raise ValueError('ChatGPT conversation ID is missing or ambiguous')
            conversation=matches[0]
        if not isinstance(conversation, dict) or not isinstance(conversation.get("mapping"), dict):
            raise ValueError("Expected one ChatGPT conversation object with mapping; select it explicitly from an export")
        nodes = conversation["mapping"]
        selected_leaf = leaf or conversation.get("current_node")
        if not selected_leaf:
            raise ValueError("An exact ChatGPT branch leaf is required")
        chain, seen, node_id = [], set(), selected_leaf
        while node_id is not None:
            if node_id in seen or node_id not in nodes:
                raise ValueError("Broken or cyclic ChatGPT branch")
            seen.add(node_id)
            node = nodes[node_id]
            if node.get("message"):
                chain.append((node_id, node["message"]))
            node_id = node.get("parent")
        session_id = conversation.get("id", conversation.get("conversation_id"))
        for node_id, message in reversed(chain):
            role = message.get("author", {}).get("role")
            metadata = message.get('metadata',{})
            if metadata.get('is_visually_hidden_from_conversation') or metadata.get('is_user_system_message') or message.get('channel') == 'analysis':
                omissions['hidden_or_context_message'] += 1
                continue
            if role not in ("user", "assistant"):
                omissions["non_dialogue_role"] += 1
                continue
            content = message.get("content", {})
            if content.get("content_type") not in ('text','multimodal_text'):
                omissions[content.get("content_type", "unknown_content")] += 1
                continue
            parts=content.get('parts',[])
            text_parts=[]
            for part in parts:
                if isinstance(part,str): text_parts.append(part)
                elif isinstance(part,dict) and part.get('content_type')=='audio_transcription' and isinstance(part.get('text'),str):
                    text_parts.append(part['text'])
                else: omissions['multimodal_non_text_part'] += 1
            text = '\n'.join(text_parts)
            omissions['attachment_reference'] += len(metadata.get('attachments',[]))
            if text.strip():
                messages.append({"source_id": node_id, "role": role, "text": text})
    else:
        records = [json.loads(line) for line in raw.splitlines() if line.strip()]
        if provider == "claude":
            if any(r.get("subtype") == "compact_boundary" for r in records):
                raise ValueError("Compacted Claude histories need a separately validated effective-context policy")
            nodes = {r["uuid"]: (i, r) for i, r in enumerate(records, 1) if r.get("uuid")}
            eligible = [r for r in records if r.get("type") in ("user", "assistant") and not r.get("isSidechain") and r.get("uuid")]
            if not eligible:
                raise ValueError("No main conversation leaf")
            selected_leaf = leaf or eligible[-1]["uuid"]
            chain, seen, node_id = [], set(), selected_leaf
            while node_id is not None:
                if node_id in seen or node_id not in nodes:
                    raise ValueError("Broken or cyclic Claude branch")
                seen.add(node_id)
                line, record = nodes[node_id]
                chain.append((line, record))
                node_id = record.get("parentUuid")
            for line, record in reversed(chain):
                session_id = record.get("sessionId", session_id)
                version = record.get("version", version)
                role = record.get("message", {}).get("role")
                if role not in ("user", "assistant"):
                    omissions["non_dialogue_record"] += 1
                    continue
                text = text_blocks(record["message"].get("content"), omissions)
                if text.strip():
                    messages.append({"source_id": record["uuid"], "line": line, "role": role, "text": text})
        elif provider == "codex":
            if leaf is not None:
                raise ValueError("This bounded Codex decoder accepts a frozen complete rollout only")
            for line, record in enumerate(records, 1):
                kind, payload = record.get("type"), record.get("payload", {})
                if kind == "session_meta" and session_id is None:
                    session_id, version = payload.get("id"), payload.get("cli_version")
                    if payload.get("history_base") or payload.get("dependency_prefix_refs"):
                        raise ValueError("External history dependency needs explicit resolution")
                if kind == "compacted":
                    raise ValueError("Compacted Codex histories need a separately validated effective-context policy")
                if kind != "response_item" or payload.get("type") != "message" or payload.get("role") not in ("user", "assistant"):
                    omissions[kind or "unknown_record"] += 1
                    continue
                role = payload["role"]
                text = text_blocks(payload.get("content"), omissions)
                if text.strip():
                    messages.append({"source_id": f"line:{line}", "line": line, "role": role, "text": text})
        else:
            raise ValueError("Unsupported provider")
    retained = []
    for message in messages:
        # These are provider scaffolding, not user dialogue. Never promote to system authority.
        if message["role"] == "user" and message["text"].lstrip().startswith(("# AGENTS.md instructions for", "<environment_context>", "<local-command-caveat>", "<command-name>")):
            omissions["provider_scaffolding"] += 1
            continue
        message["ref"] = f"M{len(retained) + 1:03}"
        message["text_sha256"] = digest(message["text"].encode())
        retained.append(message)
    return {"provider": provider, "source_sha256": digest(raw), "source_bytes": len(raw), "source_session_id": session_id,
            "source_version": version, "selected_leaf": selected_leaf, "messages": retained,
            "omissions": dict(omissions), "fidelity": "selected-branch-user-assistant-text-reconstruction"}
