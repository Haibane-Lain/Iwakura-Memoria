"""Repetition check API."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.services import projects as projects_service
from app.services import repetition as repetition_service

router = APIRouter(prefix="/api/projects", tags=["repetition"])


class RepetitionSelection(BaseModel):
    """Which documents to scan. ``folders`` uses tree ids; ``"."`` is the root.

    ``None`` (the whole ``selection`` omitted) means the entire project. An
    empty selection with both lists empty scans nothing.
    """

    folders: list[str] = Field(default_factory=list)
    documents: list[str] = Field(default_factory=list)


class WordOptions(BaseModel):
    minCount: int = 4
    minLength: int = 4
    proximityWindow: int = 50
    ignoreStopwords: bool = True
    ignoreDictionary: bool = True
    ignoreProperNouns: bool = True


class SentenceOptions(BaseModel):
    minWords: int = 6


class PhraseOptions(BaseModel):
    minWords: int = 2
    maxWords: int = 5
    minCount: int = 3


class RepetitionOptions(BaseModel):
    words: WordOptions = Field(default_factory=WordOptions)
    phrases: PhraseOptions = Field(default_factory=PhraseOptions)
    sentences: SentenceOptions = Field(default_factory=SentenceOptions)


class RepetitionRequest(BaseModel):
    selection: RepetitionSelection | None = None
    options: RepetitionOptions = Field(default_factory=RepetitionOptions)


@router.post("/{project_id}/repetition/check")
def repetition_check(project_id: str, payload: RepetitionRequest):
    selection = payload.selection
    words = payload.options.words
    try:
        dictionary = projects_service.get_dictionary(project_id).get("words", [])
        return repetition_service.analyze(
            project_id,
            folders=None if selection is None else selection.folders,
            documents=None if selection is None else selection.documents,
            dictionary=dictionary,
            word_min_count=words.minCount,
            word_min_length=words.minLength,
            proximity_window=words.proximityWindow,
            ignore_stopwords=words.ignoreStopwords,
            ignore_dictionary=words.ignoreDictionary,
            ignore_proper_nouns=words.ignoreProperNouns,
            phrase_min_words=payload.options.phrases.minWords,
            phrase_max_words=payload.options.phrases.maxWords,
            phrase_min_count=payload.options.phrases.minCount,
            sentence_min_words=payload.options.sentences.minWords,
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
